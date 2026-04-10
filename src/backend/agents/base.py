"""Base agent class — shared Claude API calling logic."""

from __future__ import annotations

import json
from typing import Any

import anthropic

from src.backend.core.config import settings

_client: anthropic.AsyncAnthropic | None = None


def get_client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        _client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
    return _client


class BaseAgent:
    """Thin wrapper around the Anthropic API with a system prompt."""

    model: str = "claude-sonnet-4-6"
    system_prompt: str = "You are a helpful assistant."
    max_tokens: int = 4096

    async def call(
        self,
        user_message: str,
        temperature: float = 0.3,
        response_format: str | None = None,
    ) -> str:
        client = get_client()
        msg = await client.messages.create(
            model=self.model,
            max_tokens=self.max_tokens,
            temperature=temperature,
            system=self.system_prompt,
            messages=[{"role": "user", "content": user_message}],
        )
        return msg.content[0].text

    async def call_json(self, user_message: str, temperature: float = 0.1) -> dict[str, Any]:
        raw = await self.call(user_message, temperature=temperature)
        # Extract JSON from response (handle markdown fences)
        text = raw.strip()
        if text.startswith("```"):
            lines = text.split("\n")
            lines = [l for l in lines if not l.startswith("```")]
            text = "\n".join(lines)
        return json.loads(text)
