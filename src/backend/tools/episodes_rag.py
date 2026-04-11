"""Keyword-based RAG for patient episodes (Yatış + Poliklinik) — Redis storage.

Separate from reports RAG: indexes episode text files (YATIS_*.txt, POLI_*.txt)
with distinct Redis keys. 3-hour TTL, cross-session reusable by protocol_id.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import re
from pathlib import Path
from typing import Any

from src.backend.core.memory import get_redis

log = logging.getLogger("cerebralink.episodes_rag")

# Chunk configuration
CHUNK_SIZE = 800
CHUNK_OVERLAP = 150

# Redis key templates — separate namespace from reports
_YATIS_CHUNKS_KEY = "cerebralink:{pid}:episodes:yatis:chunks"
_POLI_CHUNKS_KEY = "cerebralink:{pid}:episodes:poli:chunks"
_EPISODES_META_KEY = "cerebralink:{pid}:episodes:meta"
_EPISODES_SUMMARY_KEY = "cerebralink:{pid}:episodes:summary"
_TTL = 10800  # 3 hours — reusable across sessions


def _chunk_text(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Split text into overlapping chunks."""
    if len(text) <= chunk_size:
        return [text] if text.strip() else []

    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        if end < len(text):
            para_break = text.rfind("\n\n", start + chunk_size // 2, end + 100)
            if para_break > start:
                end = para_break + 1
            else:
                newline = text.rfind("\n", start + chunk_size // 2, end + 50)
                if newline > start:
                    end = newline + 1
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start = max(start + 1, end - overlap)
    return chunks


def _tokenize(text: str) -> list[str]:
    """Simple tokenization: lowercase, split on non-alphanumeric.

    Handles Turkish İ→i and I→ı mappings for proper medical term matching.
    """
    # Turkish-safe lowercase: İ→i, I→ı (standard .lower() may produce combining chars)
    text = text.replace("İ", "i").replace("I", "ı").lower()
    tokens = re.split(r"[^a-zçğıöşüâîûA-Z0-9]+", text)
    return [t for t in tokens if len(t) >= 2]


def _chunk_id(prefix: str, text: str, idx: int) -> str:
    h = hashlib.md5(f"{prefix}:{idx}:{text[:80]}".encode()).hexdigest()[:12]
    return f"{prefix}_{idx}_{h}"


async def index_episodes(
    protocol_id: str, manifest: list[dict], episodes_dir: str
) -> dict[str, int]:
    """Index all episode text files (YATIS + POLI) into Redis.

    Stores yatış and poliklinik chunks in separate Redis hashes.
    Returns {"yatis_chunks": N, "poli_chunks": N}.
    """
    r = await get_redis()
    yatis_key = _YATIS_CHUNKS_KEY.format(pid=protocol_id)
    poli_key = _POLI_CHUNKS_KEY.format(pid=protocol_id)
    meta_key = _EPISODES_META_KEY.format(pid=protocol_id)

    await r.delete(yatis_key, poli_key, meta_key)

    episodes_path = Path(episodes_dir)
    yatis_count = 0
    poli_count = 0
    pipeline = r.pipeline()

    for entry in manifest:
        output_file = entry.get("output_file", "")
        if not output_file:
            continue

        txt_path = episodes_path / output_file
        if not txt_path.exists():
            continue

        try:
            with open(txt_path, "r", encoding="utf-8") as f:
                text = f.read()
        except Exception as e:
            log.warning("Failed to read %s: %s", txt_path, e)
            continue

        if not text.strip():
            continue

        is_yatis = entry.get("is_hospitalization", False)
        chunks_key = yatis_key if is_yatis else poli_key
        prefix = "yatis" if is_yatis else "poli"

        meta = {
            "episode_id": entry.get("episode_id", ""),
            "date": entry.get("date", ""),
            "service_text": entry.get("service_text", ""),
            "facility_text": entry.get("facility_text", ""),
            "doctor_name": entry.get("doctor_name", ""),
            "is_hospitalization": is_yatis,
            "output_file": output_file,
        }

        # Add yatış-specific metadata
        if is_yatis and "yatis_bilgisi" in entry:
            yb = entry["yatis_bilgisi"]
            meta["yatis_tarihi"] = yb.get("yatis_tarihi", "")
            meta["taburcu_tarihi"] = yb.get("taburcu_tarihi", "")
            meta["yatis_sebebi"] = yb.get("yatis_sebebi", "")
            meta["yatis_tanisi"] = yb.get("yatis_tanisi", "")

        # Add diagnoses as searchable text
        diag_text = " ".join(
            f"{d.get('icd_code', '')} {d.get('name', '')}"
            for d in entry.get("diagnoses", [])
        )
        if diag_text.strip():
            meta["diagnoses_text"] = diag_text.strip()

        # Add complaints
        complaint_text = " ".join(
            c.get("title", "") + " " + c.get("text", "")
            for c in entry.get("complaints", [])
        )
        if complaint_text.strip():
            meta["complaints_text"] = complaint_text.strip()

        chunks = _chunk_text(text)
        for i, chunk in enumerate(chunks):
            cid = _chunk_id(prefix, output_file, i)
            chunk_data = {"text": chunk, "chunk_index": i, **meta}
            pipeline.hset(chunks_key, cid, json.dumps(chunk_data, ensure_ascii=False))
            if is_yatis:
                yatis_count += 1
            else:
                poli_count += 1

    total = yatis_count + poli_count
    if total > 0:
        if yatis_count > 0:
            pipeline.expire(yatis_key, _TTL)
        if poli_count > 0:
            pipeline.expire(poli_key, _TTL)
        await pipeline.execute()

    # Store manifest metadata
    await r.set(meta_key, json.dumps(manifest, ensure_ascii=False))
    await r.expire(meta_key, _TTL)

    log.info(
        "Indexed episodes for %s: %d yatış chunks, %d poli chunks",
        protocol_id, yatis_count, poli_count,
    )
    return {"yatis_chunks": yatis_count, "poli_chunks": poli_count}


async def search_episodes(
    protocol_id: str,
    query: str,
    limit: int = 5,
    episode_type: str | None = None,
) -> list[dict[str, Any]]:
    """Search across indexed episode chunks using TF-IDF scoring.

    Args:
        protocol_id: Patient protocol number.
        query: Search query.
        limit: Max results.
        episode_type: "yatis", "poli", or None (both).
    """
    r = await get_redis()

    # Determine which indices to search
    keys_to_search = []
    if episode_type in (None, "yatis"):
        keys_to_search.append(_YATIS_CHUNKS_KEY.format(pid=protocol_id))
    if episode_type in (None, "poli"):
        keys_to_search.append(_POLI_CHUNKS_KEY.format(pid=protocol_id))

    # Collect all chunks from selected indices
    all_chunks: dict[str, dict] = {}
    for key in keys_to_search:
        raw = await r.hgetall(key)
        for cid, data in raw.items():
            all_chunks[cid] = json.loads(data)

    if not all_chunks:
        return []

    query_tokens = _tokenize(query)
    if not query_tokens:
        return []

    total_docs = len(all_chunks)

    # Pre-compute document frequency
    doc_freq: dict[str, int] = {}
    parsed: dict[str, dict] = {}
    for cid, chunk_data in all_chunks.items():
        parsed[cid] = chunk_data
        # Include metadata in searchable text
        searchable = chunk_data["text"]
        for extra in ("diagnoses_text", "complaints_text", "service_text", "doctor_name"):
            if chunk_data.get(extra):
                searchable += " " + chunk_data[extra]
        chunk_tokens = set(_tokenize(searchable))
        for qt in query_tokens:
            if qt in chunk_tokens:
                doc_freq[qt] = doc_freq.get(qt, 0) + 1

    scored: list[tuple[float, str, dict]] = []
    for cid, chunk_data in parsed.items():
        searchable = chunk_data["text"]
        for extra in ("diagnoses_text", "complaints_text", "service_text", "doctor_name"):
            if chunk_data.get(extra):
                searchable += " " + chunk_data[extra]

        chunk_tokens = _tokenize(searchable)
        token_counts: dict[str, int] = {}
        for t in chunk_tokens:
            token_counts[t] = token_counts.get(t, 0) + 1

        score = 0.0
        for qt in query_tokens:
            tf = token_counts.get(qt, 0)
            if tf == 0:
                continue
            df = doc_freq.get(qt, 1)
            idf = math.log(total_docs / df) if df > 0 else 0
            score += tf * idf
            if qt in searchable.lower():
                score += 0.5

        # Boost yatış episodes slightly for hospitalization-related queries
        if score > 0 and chunk_data.get("is_hospitalization"):
            hosp_terms = {"yatış", "yatis", "hospitalization", "admission", "taburcu", "discharge"}
            if any(t in hosp_terms for t in query_tokens):
                score *= 1.3

        if score > 0:
            scored.append((score, cid, chunk_data))

    scored.sort(key=lambda x: -x[0])

    results = []
    for score, cid, chunk_data in scored[:limit]:
        results.append({
            "chunk_id": cid,
            "text": chunk_data["text"],
            "score": round(score, 3),
            "episode_id": chunk_data.get("episode_id", ""),
            "date": chunk_data.get("date", ""),
            "service_text": chunk_data.get("service_text", ""),
            "facility_text": chunk_data.get("facility_text", ""),
            "doctor_name": chunk_data.get("doctor_name", ""),
            "is_hospitalization": chunk_data.get("is_hospitalization", False),
            "output_file": chunk_data.get("output_file", ""),
        })
    return results


async def episodes_indexed(protocol_id: str) -> bool:
    """Check if episode chunks are still in Redis (not expired)."""
    r = await get_redis()
    yatis_key = _YATIS_CHUNKS_KEY.format(pid=protocol_id)
    poli_key = _POLI_CHUNKS_KEY.format(pid=protocol_id)
    return (await r.exists(yatis_key) > 0) or (await r.exists(poli_key) > 0)


async def store_episodes_summary(protocol_id: str, summary: str) -> None:
    """Cache a generated episodes summary in Redis."""
    r = await get_redis()
    key = _EPISODES_SUMMARY_KEY.format(pid=protocol_id)
    await r.set(key, summary)
    await r.expire(key, _TTL)
    log.info("Stored episode summary for %s (%d chars)", protocol_id, len(summary))


async def get_episodes_summary(protocol_id: str) -> str | None:
    """Retrieve cached episode summary from Redis."""
    r = await get_redis()
    key = _EPISODES_SUMMARY_KEY.format(pid=protocol_id)
    return await r.get(key)
