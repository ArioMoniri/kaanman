"""Exa API client — searches for latest medical guidelines across countries."""

from __future__ import annotations

from typing import Any

import httpx

from src.backend.core.config import settings

EXA_API_URL = "https://api.exa.ai/search"
_TIMEOUT = 15.0


class ExaClient:
    """Exa.ai search client for finding latest medical guidelines."""

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or settings.exa_api_key

    async def search_medical(
        self,
        query: str,
        countries: list[str] | None = None,
        num_results: int = 5,
    ) -> list[dict[str, Any]]:
        if not self.api_key:
            return []

        countries = countries or ["USA", "Europe", "UK"]
        country_terms = " OR ".join(
            f'"{c} guidelines"' for c in countries
        )
        full_query = f"latest clinical guidelines {query} ({country_terms})"

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "query": full_query,
            "numResults": num_results,
            "useAutoprompt": True,
            "type": "auto",
            "contents": {"text": {"maxCharacters": 2000}},
        }

        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.post(EXA_API_URL, json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()
                results = data.get("results", [])
                return [
                    {
                        "title": r.get("title", ""),
                        "url": r.get("url", ""),
                        "published_date": r.get("publishedDate"),
                        "text": r.get("text", "")[:1500],
                        "score": r.get("score"),
                    }
                    for r in results
                ]
        except Exception as e:
            return [{"error": str(e)}]
