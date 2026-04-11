"""Simple keyword-based RAG for patient reports — no vector DB needed.

Indexes report text chunks in Redis and provides keyword-based search
with TF-IDF-style scoring. Also caches generated patient briefs.
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

log = logging.getLogger("cerebralink.reports_rag")

# Chunk configuration
CHUNK_SIZE = 1000
CHUNK_OVERLAP = 200

# Redis key templates
_CHUNKS_KEY = "cerebralink:{pid}:reports:chunks"
_META_KEY = "cerebralink:{pid}:reports:meta"
_BRIEF_KEY = "cerebralink:{pid}:reports:brief"
_TTL = 10800  # 3 hours — reusable across sessions by protocol_id within window


def _chunk_text(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Split text into overlapping chunks of approximately chunk_size chars.

    Tries to break at paragraph or sentence boundaries when possible.
    """
    if len(text) <= chunk_size:
        return [text] if text.strip() else []

    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = start + chunk_size

        # Try to break at a paragraph boundary
        if end < len(text):
            # Look for paragraph break near the end
            para_break = text.rfind("\n\n", start + chunk_size // 2, end + 100)
            if para_break > start:
                end = para_break + 1
            else:
                # Try sentence boundary (period + space or newline)
                sent_break = text.rfind(". ", start + chunk_size // 2, end + 50)
                if sent_break > start:
                    end = sent_break + 2
                else:
                    newline = text.rfind("\n", start + chunk_size // 2, end + 50)
                    if newline > start:
                        end = newline + 1

        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)

        # Move start forward, accounting for overlap
        start = max(start + 1, end - overlap)

    return chunks


def _tokenize(text: str) -> list[str]:
    """Simple tokenization: lowercase, split on non-alphanumeric, remove short words.

    Handles Turkish İ→i and I→ı mappings for proper medical term matching.
    """
    # Turkish-safe lowercase: İ→i, I→ı (standard .lower() may produce combining chars)
    text = text.replace("İ", "i").replace("I", "ı").lower()
    tokens = re.split(r"[^a-zçğıöşüâîûA-Z0-9]+", text)
    return [t for t in tokens if len(t) >= 2]


def _chunk_id(text: str, idx: int) -> str:
    """Generate a deterministic chunk ID."""
    h = hashlib.md5(f"{idx}:{text[:100]}".encode()).hexdigest()[:12]
    return f"chunk_{idx}_{h}"


async def index_reports(
    protocol_id: str, manifest: list[dict], reports_dir: str
) -> int:
    """Read all TXT files from the manifest, chunk them, store in Redis.

    Args:
        protocol_id: Patient protocol number.
        manifest: Report manifest entries.
        reports_dir: Path to the reports directory.

    Returns:
        Number of chunks indexed.
    """
    r = await get_redis()
    chunks_key = _CHUNKS_KEY.format(pid=protocol_id)
    meta_key = _META_KEY.format(pid=protocol_id)

    # Clear any existing index for this patient
    await r.delete(chunks_key, meta_key)

    reports_path = Path(reports_dir)
    chunk_count = 0
    pipeline = r.pipeline()

    for entry in manifest:
        text_file = entry.get("text_file")
        if not text_file:
            continue

        txt_path = reports_path / text_file
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

        # Build metadata for this report
        meta = {
            "report_type": entry.get("report_type", ""),
            "report_type_swc": entry.get("report_type_swc", ""),
            "report_name": entry.get("report_name", ""),
            "date": entry.get("date", ""),
            "facility": entry.get("facility", ""),
            "filename": text_file,
            "original_file": entry.get("file", ""),  # may be .pdf, .rtf, .html
        }

        chunks = _chunk_text(text)
        for i, chunk in enumerate(chunks):
            cid = _chunk_id(text_file, i)
            chunk_data = {
                "text": chunk,
                "chunk_index": i,
                **meta,
            }
            pipeline.hset(chunks_key, cid, json.dumps(chunk_data, ensure_ascii=False))
            chunk_count += 1

    if chunk_count > 0:
        pipeline.expire(chunks_key, _TTL)
        await pipeline.execute()

    # Store manifest metadata
    await r.set(meta_key, json.dumps(manifest, ensure_ascii=False))
    await r.expire(meta_key, _TTL)

    log.info("Indexed %d chunks for patient %s", chunk_count, protocol_id)
    return chunk_count


async def search_reports(
    protocol_id: str, query: str, limit: int = 5
) -> list[dict[str, Any]]:
    """Keyword search across indexed report chunks.

    Uses simple TF-IDF-style scoring: split query into tokens,
    count matches per chunk, rank by score.

    Args:
        protocol_id: Patient protocol number.
        query: Search query string.
        limit: Max number of results to return.

    Returns:
        List of matching chunks with metadata and relevance score.
    """
    r = await get_redis()
    chunks_key = _CHUNKS_KEY.format(pid=protocol_id)

    # Get all chunks
    all_chunks = await r.hgetall(chunks_key)
    if not all_chunks:
        return []

    query_tokens = _tokenize(query)
    if not query_tokens:
        return []

    # Score each chunk
    scored: list[tuple[float, str, dict]] = []
    total_docs = len(all_chunks)

    # Pre-compute document frequency for each query token
    doc_freq: dict[str, int] = {}
    parsed_chunks: dict[str, dict] = {}
    for cid, raw in all_chunks.items():
        chunk_data = json.loads(raw)
        parsed_chunks[cid] = chunk_data
        chunk_tokens = set(_tokenize(chunk_data["text"]))
        for qt in query_tokens:
            if qt in chunk_tokens:
                doc_freq[qt] = doc_freq.get(qt, 0) + 1

    for cid, chunk_data in parsed_chunks.items():
        chunk_text_lower = chunk_data["text"].lower()
        chunk_tokens = _tokenize(chunk_data["text"])
        token_counts: dict[str, int] = {}
        for t in chunk_tokens:
            token_counts[t] = token_counts.get(t, 0) + 1

        score = 0.0
        for qt in query_tokens:
            tf = token_counts.get(qt, 0)
            if tf == 0:
                continue
            # TF-IDF: tf * log(N / df)
            df = doc_freq.get(qt, 1)
            idf = math.log(total_docs / df) if df > 0 else 0
            score += tf * idf

            # Bonus for exact phrase match
            if qt in chunk_text_lower:
                score += 0.5

        if score > 0:
            scored.append((score, cid, chunk_data))

    # Sort by score descending
    scored.sort(key=lambda x: -x[0])

    results = []
    for score, cid, chunk_data in scored[:limit]:
        results.append({
            "chunk_id": cid,
            "text": chunk_data["text"],
            "score": round(score, 3),
            "report_type": chunk_data.get("report_type", ""),
            "report_name": chunk_data.get("report_name", ""),
            "date": chunk_data.get("date", ""),
            "facility": chunk_data.get("facility", ""),
            "filename": chunk_data.get("filename", ""),
            "original_file": chunk_data.get("original_file", ""),
        })

    return results


async def chunks_indexed(protocol_id: str) -> bool:
    """Check whether report chunks are still present in Redis (not expired)."""
    r = await get_redis()
    chunks_key = _CHUNKS_KEY.format(pid=protocol_id)
    return await r.exists(chunks_key) > 0


async def get_report_brief(protocol_id: str) -> str | None:
    """Retrieve a cached patient report brief from Redis."""
    r = await get_redis()
    brief_key = _BRIEF_KEY.format(pid=protocol_id)
    return await r.get(brief_key)


async def store_report_brief(protocol_id: str, brief: str) -> None:
    """Cache a generated patient report brief in Redis."""
    r = await get_redis()
    brief_key = _BRIEF_KEY.format(pid=protocol_id)
    await r.set(brief_key, brief)
    await r.expire(brief_key, _TTL)
    log.info("Stored report brief for patient %s (%d chars)", protocol_id, len(brief))
