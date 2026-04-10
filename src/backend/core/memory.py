"""Redis-backed MCP memory store with per-agent and shared memory layers.

Architecture:
  - SessionMemory: patient context + conversation history (per session)
  - AgentMemory: private scratch-pad for each agent (per session + agent)
  - SharedMemory: cross-agent shared data (per session, readable by all)
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

import redis.asyncio as aioredis

from src.backend.core.config import settings

_pool: aioredis.Redis | None = None
_TTL = 86400  # 24 hours


async def get_redis() -> aioredis.Redis:
    global _pool
    if _pool is None:
        _pool = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _pool


class SessionMemory:
    """Per-session memory: patient context + conversation history."""

    def __init__(self, session_id: str | None = None):
        self.session_id = session_id or str(uuid.uuid4())
        self._prefix = f"cerebralink:{self.session_id}"

    async def _r(self) -> aioredis.Redis:
        return await get_redis()

    async def set_patient_context(self, masked_data: dict[str, Any]) -> None:
        r = await self._r()
        await r.set(f"{self._prefix}:patient", json.dumps(masked_data, ensure_ascii=False))
        await r.expire(f"{self._prefix}:patient", _TTL)

    async def get_patient_context(self) -> dict[str, Any] | None:
        r = await self._r()
        raw = await r.get(f"{self._prefix}:patient")
        return json.loads(raw) if raw else None

    async def clear_patient_context(self) -> None:
        r = await self._r()
        await r.delete(f"{self._prefix}:patient")

    async def append_message(self, role: str, content: str, meta: dict | None = None) -> None:
        r = await self._r()
        entry = {"role": role, "content": content, "ts": time.time(), **(meta or {})}
        await r.rpush(f"{self._prefix}:messages", json.dumps(entry, ensure_ascii=False))
        await r.expire(f"{self._prefix}:messages", _TTL)

    async def get_history(self, last_n: int = 20) -> list[dict]:
        r = await self._r()
        raw = await r.lrange(f"{self._prefix}:messages", -last_n, -1)
        return [json.loads(m) for m in raw]

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


class AgentMemory:
    """Per-agent private memory within a session.

    Each agent gets its own hash in Redis. Other agents cannot see this data.
    Used for: agent-specific reasoning traces, intermediate calculations,
    cached decisions, and turn-over-turn context that only that agent needs.
    """

    def __init__(self, session_id: str, agent_name: str):
        self.session_id = session_id
        self.agent_name = agent_name
        self._key = f"cerebralink:{session_id}:agent_private:{agent_name}"

    async def _r(self) -> aioredis.Redis:
        return await get_redis()

    async def put(self, key: str, value: Any) -> None:
        r = await self._r()
        await r.hset(self._key, key, json.dumps(value, ensure_ascii=False))
        await r.expire(self._key, _TTL)

    async def get(self, key: str) -> Any:
        r = await self._r()
        raw = await r.hget(self._key, key)
        return json.loads(raw) if raw else None

    async def get_all(self) -> dict[str, Any]:
        r = await self._r()
        raw = await r.hgetall(self._key)
        return {k: json.loads(v) for k, v in raw.items()}

    async def delete(self, key: str) -> None:
        r = await self._r()
        await r.hdel(self._key, key)

    async def clear(self) -> None:
        r = await self._r()
        await r.delete(self._key)


class SharedMemory:
    """Cross-agent shared memory within a session.

    All agents can read and write to this store. Used for:
    - Route decisions (so downstream agents know the classification)
    - Clinical findings that multiple agents need
    - Consultation flags raised by one agent, consumed by another
    - Accumulated guideline references
    - Calculation results shared between drug and clinical agents
    """

    def __init__(self, session_id: str):
        self.session_id = session_id
        self._key = f"cerebralink:{session_id}:shared"

    async def _r(self) -> aioredis.Redis:
        return await get_redis()

    async def put(self, key: str, value: Any) -> None:
        r = await self._r()
        await r.hset(self._key, key, json.dumps(value, ensure_ascii=False))
        await r.expire(self._key, _TTL)

    async def get(self, key: str) -> Any:
        r = await self._r()
        raw = await r.hget(self._key, key)
        return json.loads(raw) if raw else None

    async def get_all(self) -> dict[str, Any]:
        r = await self._r()
        raw = await r.hgetall(self._key)
        return {k: json.loads(v) for k, v in raw.items()}

    async def append_list(self, key: str, item: Any) -> None:
        """Append to a list stored under `key`."""
        r = await self._r()
        existing = await self.get(key)
        lst = existing if isinstance(existing, list) else []
        lst.append(item)
        await self.put(key, lst)

    async def clear(self) -> None:
        r = await self._r()
        await r.delete(self._key)
