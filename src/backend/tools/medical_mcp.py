"""Medical MCP client — interfaces with the medical-mcp server for drug/guideline data."""

from __future__ import annotations

import json
from typing import Any

import httpx

from src.backend.core.config import settings

_TIMEOUT = 15.0


class MedicalMCPClient:
    """HTTP client for the medical-mcp MCP server (runs as sidecar in Docker)."""

    def __init__(self, base_url: str | None = None):
        self.base_url = (base_url or settings.medical_mcp_url).rstrip("/")

    async def _call_tool(self, tool_name: str, args: dict[str, Any]) -> Any:
        """Call an MCP tool via the server's JSON-RPC endpoint."""
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": args},
        }
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.post(f"{self.base_url}/mcp", json=payload)
                resp.raise_for_status()
                data = resp.json()
                result = data.get("result", {})
                # MCP returns content as array of {type, text}
                content = result.get("content", [])
                if content and isinstance(content, list):
                    texts = [c.get("text", "") for c in content if c.get("type") == "text"]
                    combined = "\n".join(texts)
                    try:
                        return json.loads(combined)
                    except json.JSONDecodeError:
                        return {"text": combined}
                return result
        except Exception as e:
            return {"error": str(e), "tool": tool_name}

    async def search_drugs(self, query: str) -> Any:
        return await self._call_tool("search-drugs", {"query": query})

    async def get_drug_details(self, ndc: str) -> Any:
        return await self._call_tool("get-drug-details", {"ndc": ndc})

    async def search_guidelines(self, query: str) -> Any:
        return await self._call_tool("search-clinical-guidelines", {"query": query})

    async def search_literature(self, query: str) -> Any:
        return await self._call_tool("search-medical-literature", {"query": query})

    async def search_pediatric_guidelines(self, query: str) -> Any:
        return await self._call_tool("search-pediatric-guidelines", {"query": query})

    async def get_health_stats(self, indicator: str, country: str) -> Any:
        return await self._call_tool("get-health-statistics", {
            "indicator": indicator, "country": country,
        })
