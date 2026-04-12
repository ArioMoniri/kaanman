"""Keyword-based RAG for patient Izlem (monitoring) data -- Redis storage.

Indexes izlem data (hekim notes, hemsire notes, vitals, medications, labs, etc.)
with distinct Redis keys per data type. 3-hour TTL, cross-session reusable.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import re
from typing import Any

from src.backend.core.memory import get_redis

log = logging.getLogger("cerebralink.izlem_rag")

# Chunk configuration
CHUNK_SIZE = 800
CHUNK_OVERLAP = 150

# Redis key templates -- separate namespace from episodes/reports
_IZLEM_CHUNKS_KEY = "cerebralink:{pid}:izlem:chunks"
_IZLEM_META_KEY = "cerebralink:{pid}:izlem:meta"
_IZLEM_SUMMARY_KEY = "cerebralink:{pid}:izlem:summary"
_TTL = 10800  # 3 hours -- reusable across sessions


def _chunk_text(
    text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP
) -> list[str]:
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

    Handles Turkish I->i and I->i mappings for proper medical term matching.
    """
    # Turkish-safe lowercase: I with dot above -> i, I without dot -> dotless i
    text = text.replace("\u0130", "i").replace("I", "\u0131").lower()
    tokens = re.split(r"[^a-z\xe7\u011f\u0131\xf6\u015f\xfc\xe2\xee\xfbA-Z0-9]+", text)
    return [t for t in tokens if len(t) >= 2]


def _chunk_id(prefix: str, text: str, idx: int) -> str:
    h = hashlib.md5(f"{prefix}:{idx}:{text[:80]}".encode()).hexdigest()[:12]
    return f"{prefix}_{idx}_{h}"


# ---------------------------------------------------------------------------
# Flatten helpers — convert structured izlem records to readable text
# ---------------------------------------------------------------------------

def _flatten_hekim_izlem(records: list[dict], episode_ctx: str) -> list[str]:
    """Flatten hekim (physician) monitoring notes."""
    lines: list[str] = []
    for rec in records:
        date = rec.get("col_0", rec.get("Tarih", ""))
        doctor = rec.get("col_1", rec.get("Hekim", ""))
        note = rec.get("col_2", rec.get("Not", ""))
        if note:
            lines.append(f"Hekim Izlem: [{date}] {doctor} -- {note}")
    if lines:
        return [f"{episode_ctx}\n" + "\n".join(lines)]
    return []


def _flatten_hemsire_izlem(records: list[dict], episode_ctx: str) -> list[str]:
    """Flatten hemsire (nurse) monitoring notes."""
    lines: list[str] = []
    for rec in records:
        date = rec.get("col_0", rec.get("Tarih", ""))
        note = rec.get("col_1", rec.get("col_2", rec.get("Not", "")))
        if note:
            lines.append(f"Hemsire: [{date}] -- {note}")
    if lines:
        return [f"{episode_ctx}\n" + "\n".join(lines)]
    return []


def _flatten_vital_bulgular(records: list[dict], episode_ctx: str) -> list[str]:
    """Flatten vital signs into readable text."""
    lines: list[str] = []
    for rec in records:
        date = rec.get("Tarih", "")
        parts = [f"Tarih={date}"]
        for key in ("Nabiz", "Nab\u0131z", "Tansiyon", "SpO2", "Ates", "Ate\u015f",
                     "Solunum", "Boy", "Kilo", "VKI", "BMI"):
            val = rec.get(key, "")
            if val:
                parts.append(f"{key}={val}")
        lines.append("Vital: " + " ".join(parts))
    if lines:
        return [f"{episode_ctx}\n" + "\n".join(lines)]
    return []


def _flatten_ilac_izlem(records: list[dict], episode_ctx: str) -> list[str]:
    """Flatten medication monitoring records."""
    lines: list[str] = []
    for rec in records:
        drug = rec.get("\u0130la\xe7 Ad\u0131", rec.get("Ilac", rec.get("col_0", "")))
        dose = rec.get("Doz", rec.get("col_1", ""))
        parts = [f"Ilac={drug}"]
        if dose:
            parts.append(f"Doz={dose}")
        # Include any other columns
        for k, v in rec.items():
            if k not in ("\u0130la\xe7 Ad\u0131", "Ilac", "Doz", "col_0", "col_1") and v:
                parts.append(f"{k}={v}")
        lines.append("Ilac: " + " ".join(parts))
    if lines:
        return [f"{episode_ctx}\n" + "\n".join(lines)]
    return []


def _flatten_generic(records: list[dict], data_type: str, episode_ctx: str) -> list[str]:
    """Flatten any other data type generically."""
    lines: list[str] = []
    label = data_type.replace("_", " ").title()
    for rec in records:
        parts = []
        for k, v in rec.items():
            if v:
                parts.append(f"{k}={v}")
        if parts:
            lines.append(f"{label}: " + ", ".join(parts))
    if lines:
        return [f"{episode_ctx}\n" + "\n".join(lines)]
    return []


_FLATTEN_MAP: dict[str, Any] = {
    "hekim_izlem_notlari": _flatten_hekim_izlem,
    "hemsire_izlem_notlari": _flatten_hemsire_izlem,
    "vital_bulgular": _flatten_vital_bulgular,
    "ilac_izlem": _flatten_ilac_izlem,
}


def _flatten_episode_data(
    episode: dict,
) -> list[dict[str, Any]]:
    """Flatten all data types from a single izlem episode into chunk dicts.

    Returns list of {"text": str, "data_type": str, "episode_id": str, ...}.
    """
    ep_info = episode.get("episode_info", {})
    episode_id = str(ep_info.get("episodeId", ""))
    date = ep_info.get("date", "")
    service_text = ep_info.get("serviceText", "")
    facility_text = ep_info.get("facilityText", "")
    episode_ctx = f"[Epizod {episode_id} | {date} | {service_text}]"

    data = episode.get("data", {})
    result: list[dict[str, Any]] = []

    for data_type, records in data.items():
        if not isinstance(records, list) or not records:
            continue

        flatten_fn = _FLATTEN_MAP.get(data_type, None)
        if flatten_fn:
            text_blocks = flatten_fn(records, episode_ctx)
        else:
            text_blocks = _flatten_generic(records, data_type, episode_ctx)

        for block in text_blocks:
            result.append({
                "text": block,
                "data_type": data_type,
                "episode_id": episode_id,
                "date": date,
                "service_text": service_text,
                "facility_text": facility_text,
            })

    return result


# ---------------------------------------------------------------------------
# Index / Search
# ---------------------------------------------------------------------------


async def index_izlem(
    protocol_id: str, izlem_data: dict
) -> dict[str, int]:
    """Index all izlem data into Redis.

    For each episode's data, flatten each data type into text chunks.
    Returns {"chunks_indexed": N}.
    """
    r = await get_redis()
    chunks_key = _IZLEM_CHUNKS_KEY.format(pid=protocol_id)
    meta_key = _IZLEM_META_KEY.format(pid=protocol_id)

    await r.delete(chunks_key, meta_key)

    pipeline = r.pipeline()
    total_chunks = 0

    episodes = izlem_data.get("episodes", [])

    for episode in episodes:
        flat_items = _flatten_episode_data(episode)

        for item in flat_items:
            text = item["text"]
            chunks = _chunk_text(text)

            for i, chunk in enumerate(chunks):
                cid = _chunk_id(
                    f"izlem_{item['data_type']}",
                    f"{item['episode_id']}_{item['data_type']}",
                    total_chunks + i,
                )
                chunk_data = {
                    "text": chunk,
                    "chunk_index": i,
                    "data_type": item["data_type"],
                    "episode_id": item["episode_id"],
                    "date": item["date"],
                    "service_text": item["service_text"],
                    "facility_text": item["facility_text"],
                }
                pipeline.hset(
                    chunks_key,
                    cid,
                    json.dumps(chunk_data, ensure_ascii=False),
                )
                total_chunks += 1

    if total_chunks > 0:
        pipeline.expire(chunks_key, _TTL)
        await pipeline.execute()

    # Store metadata
    meta = izlem_data.get("meta", {})
    await r.set(meta_key, json.dumps(meta, ensure_ascii=False))
    await r.expire(meta_key, _TTL)

    log.info("Indexed izlem for %s: %d chunks", protocol_id, total_chunks)
    return {"chunks_indexed": total_chunks}


async def search_izlem(
    protocol_id: str,
    query: str,
    limit: int = 5,
    data_type: str | None = None,
) -> list[dict[str, Any]]:
    """Search across indexed izlem chunks using TF-IDF scoring.

    Args:
        protocol_id: Patient protocol number.
        query: Search query.
        limit: Max results.
        data_type: Optional filter, e.g. "vital_bulgular", "hekim_izlem_notlari".
    """
    r = await get_redis()
    chunks_key = _IZLEM_CHUNKS_KEY.format(pid=protocol_id)

    raw = await r.hgetall(chunks_key)
    if not raw:
        return []

    # Parse all chunks, optionally filtering by data_type
    all_chunks: dict[str, dict] = {}
    for cid, data in raw.items():
        parsed = json.loads(data)
        if data_type and parsed.get("data_type") != data_type:
            continue
        all_chunks[cid] = parsed

    if not all_chunks:
        return []

    query_tokens = _tokenize(query)
    if not query_tokens:
        return []

    total_docs = len(all_chunks)

    # Pre-compute document frequency
    doc_freq: dict[str, int] = {}
    for cid, chunk_data in all_chunks.items():
        searchable = chunk_data["text"]
        for extra in ("service_text", "data_type"):
            if chunk_data.get(extra):
                searchable += " " + chunk_data[extra]
        chunk_tokens = set(_tokenize(searchable))
        for qt in query_tokens:
            if qt in chunk_tokens:
                doc_freq[qt] = doc_freq.get(qt, 0) + 1

    scored: list[tuple[float, str, dict]] = []
    for cid, chunk_data in all_chunks.items():
        searchable = chunk_data["text"]
        for extra in ("service_text", "data_type"):
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
            # Exact substring bonus
            if qt in searchable.lower():
                score += 0.5

        # Boost certain data types for relevant queries
        if score > 0:
            dt = chunk_data.get("data_type", "")
            vital_terms = {"vital", "nabiz", "nab\u0131z", "tansiyon", "spo2",
                           "ates", "ate\u015f", "solunum"}
            ilac_terms = {"ilac", "ila\xe7", "doz", "medikasyon", "tedavi",
                          "antibiyotik"}
            lab_terms = {"lab", "laboratuvar", "kan", "hemogram", "biyokimya"}

            if dt == "vital_bulgular" and any(t in vital_terms for t in query_tokens):
                score *= 1.3
            elif dt == "ilac_izlem" and any(t in ilac_terms for t in query_tokens):
                score *= 1.3
            elif "laboratuvar" in dt and any(t in lab_terms for t in query_tokens):
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
            "data_type": chunk_data.get("data_type", ""),
            "episode_id": chunk_data.get("episode_id", ""),
            "date": chunk_data.get("date", ""),
            "service_text": chunk_data.get("service_text", ""),
            "facility_text": chunk_data.get("facility_text", ""),
        })
    return results


async def izlem_indexed(protocol_id: str) -> bool:
    """Check if izlem chunks are still in Redis (not expired)."""
    r = await get_redis()
    chunks_key = _IZLEM_CHUNKS_KEY.format(pid=protocol_id)
    return (await r.exists(chunks_key)) > 0


async def get_izlem_summary_key(protocol_id: str) -> str:
    """Return the Redis key used for cached izlem summary."""
    return _IZLEM_SUMMARY_KEY.format(pid=protocol_id)


async def store_izlem_summary(protocol_id: str, summary: str) -> None:
    """Cache a generated izlem summary in Redis."""
    r = await get_redis()
    key = _IZLEM_SUMMARY_KEY.format(pid=protocol_id)
    await r.set(key, summary)
    await r.expire(key, _TTL)
    log.info("Stored izlem summary for %s (%d chars)", protocol_id, len(summary))


async def get_izlem_summary(protocol_id: str) -> str | None:
    """Retrieve cached izlem summary from Redis."""
    r = await get_redis()
    key = _IZLEM_SUMMARY_KEY.format(pid=protocol_id)
    return await r.get(key)
