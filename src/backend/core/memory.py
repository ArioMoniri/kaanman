"""Redis-backed MCP memory store for session and patient context."""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

import redis.asyncio as aioredis

from src.backend.core.config import settings

_pool: aioredis.Redis | None = None


async def get_redis() -> aioredis.Redis:
    global _pool
    if _pool is None:
        _pool = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _pool


class SessionMemory:
    """Per-session memory backed by Redis.  Stores patient context,
    conversation history, and agent scratch-pad data."""

    def __init__(self, session_id: str | None = None):
        self.session_id = session_id or str(uuid.uuid4())
        self._prefix = f"cerebralink:{self.session_id}"

    async def _r(self) -> aioredis.Redis:
        return await get_redis()

    # --- patient context ---
    async def set_patient_context(self, masked_data: dict[str, Any]) -> None:
        r = await self._r()
        await r.set(f"{self._prefix}:patient", json.dumps(masked_data, ensure_ascii=False))
        await r.expire(f"{self._prefix}:patient", 86400)  # 24h TTL

    async def get_patient_context(self) -> dict[str, Any] | None:
        r = await self._r()
        raw = await r.get(f"{self._prefix}:patient")
        return json.loads(raw) if raw else None

    async def clear_patient_context(self) -> None:
        r = await self._r()
        await r.delete(f"{self._prefix}:patient")

    # --- conversation history ---
    async def append_message(self, role: str, content: str, meta: dict | None = None) -> None:
        r = await self._r()
        entry = {"role": role, "content": content, "ts": time.time(), **(meta or {})}
        await r.rpush(f"{self._prefix}:messages", json.dumps(entry, ensure_ascii=False))
        await r.expire(f"{self._prefix}:messages", 86400)

    async def get_history(self, last_n: int = 20) -> list[dict]:
        r = await self._r()
        raw = await r.lrange(f"{self._prefix}:messages", -last_n, -1)
        return [json.loads(m) for m in raw]

    # --- agent scratch-pad (key-value) ---
    async def agent_put(self, agent: str, key: str, value: Any) -> None:
        r = await self._r()
        await r.hset(f"{self._prefix}:agents:{agent}", key, json.dumps(value, ensure_ascii=False))
        await r.expire(f"{self._prefix}:agents:{agent}", 86400)

    async def agent_get(self, agent: str, key: str) -> Any:
        r = await self._r()
        raw = await r.hget(f"{self._prefix}:agents:{agent}", key)
        return json.loads(raw) if raw else None

    # --- session lifecycle ---
    async def clear_session(self) -> None:
        r = await self._r()
        keys = []
        async for key in r.scan_iter(f"{self._prefix}:*"):
            keys.append(key)
        if keys:
            await r.delete(*keys)

    async def session_info(self) -> dict[str, Any]:
        r = await self._r()
        has_patient = await r.exists(f"{self._prefix}:patient") > 0
        msg_count = await r.llen(f"{self._prefix}:messages")
        return {
            "session_id": self.session_id,
            "has_patient": has_patient,
            "message_count": msg_count,
        }
