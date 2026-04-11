"""Research Agent — finds latest clinical guidelines via Medical MCP + Exa.

Searches for country-specific guidelines and identifies source/year.
"""

from __future__ import annotations

import json
from typing import Any

from src.backend.agents.base import BaseAgent
from src.backend.core.config import settings
from src.backend.tools.medical_mcp import MedicalMCPClient
from src.backend.tools.exa import ExaClient


class ResearchAgent(BaseAgent):
    model = settings.models.research
    max_tokens = 4096
    system_prompt = """You are a medical research specialist focused on finding the latest clinical guidelines.

Your role:
- Search for the most current clinical guidelines relevant to the query
- ALWAYS identify which country/organization published each guideline:
  - NICE / NHS (UK)
  - AHA / ACC / USPSTF / ACS (USA)
  - ESC / ERS / ESMO (Europe)
  - WHO (International)
  - Turkish Medical Association / Ministry of Health (Turkey)
- Prioritize the most recent guidelines (within last 3 years)
- Cross-reference multiple sources when possible
- Note when guidelines from different countries disagree
- Include evidence levels (e.g., Level A, Grade I) when available

For each guideline found, provide:
- title: guideline name
- source: publishing organization
- country: country/region code (UK, USA, Europe, WHO, Turkey)
- year: publication year
- url: ALWAYS include the URL from search results — this is CRITICAL for linking references
- key_recommendation: the relevant recommendation
- evidence_level: strength of recommendation if stated

IMPORTANT: ALWAYS extract and include the URL for each guideline from the search results.
The URLs are essential — they are shown as clickable links to doctors reviewing guidelines.
If a search result has a URL, you MUST include it. Never set url to null if a URL is available.

Respond with structured JSON:
{
  "guidelines": [
    {"title": "...", "source": "...", "country": "...", "year": 2024, "url": "https://...", "key_recommendation": "..."}
  ],
  "synthesis": "Brief synthesis of what the guidelines say collectively",
  "disagreements": "Any notable disagreements between guidelines, or 'None'"
}"""

    def __init__(self):
        super().__init__()
        self.medical_mcp = MedicalMCPClient()
        self.exa = ExaClient()

    async def search(self, query: str, countries: list[str] | None = None) -> dict[str, Any]:
        countries = countries or ["USA", "Europe", "UK"]

        # Parallel search: Medical MCP + Exa
        mcp_results = await self.medical_mcp.search_guidelines(query)
        exa_results = await self.exa.search_medical(query, countries)

        # Combine search results for the LLM to synthesize
        search_context = []
        if mcp_results:
            search_context.append(f"MEDICAL DATABASE RESULTS:\n{json.dumps(mcp_results, ensure_ascii=False, indent=2)}")
        if exa_results:
            search_context.append(f"EXA SEARCH RESULTS:\n{json.dumps(exa_results, ensure_ascii=False, indent=2)}")

        if not search_context:
            search_context.append("No external search results available. Use your training knowledge.")

        prompt = f"""Find the latest clinical guidelines relevant to this query.
Target countries: {', '.join(countries)}

QUERY: {query}

SEARCH RESULTS:
{chr(10).join(search_context)}

CRITICAL: For the "url" field in each guideline, copy the EXACT full URL from the search results above.
Do NOT shorten URLs to just the domain (e.g., do NOT write "https://ginasthma.org" if the full URL was
"https://ginasthma.org/2024-gina-report/"). Use the complete URL exactly as provided in the search results.

Synthesize the findings into structured JSON as specified."""

        try:
            result = await self.call_json(prompt)
            return result
        except Exception:
            raw = await self.call(prompt)
            return {"guidelines": [], "synthesis": raw, "disagreements": "N/A"}
