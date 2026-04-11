"""Research Agent — finds latest clinical guidelines via Medical MCP + Exa.

Searches for country-specific guidelines and identifies source/year.
"""

from __future__ import annotations

import json
from datetime import date
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
- evidence_level: strength of recommendation if stated (e.g. "Level A", "Grade I", "1a", "Class IIa")
- importance: how important this guideline is for the specific query — "high", "medium", or "low"
- effect_size: if the guideline discusses treatment outcomes, rate the effect size — "large", "moderate", "small", or "none"

IMPORTANT: ALWAYS extract and include the URL for each guideline from the search results.
The URLs are essential — they are shown as clickable links to doctors reviewing guidelines.
If a search result has a URL, you MUST include it. Never set url to null if a URL is available.

Respond with structured JSON:
{
  "guidelines": [
    {"title": "...", "source": "...", "country": "...", "year": 2024, "url": "https://...", "key_recommendation": "...", "evidence_level": "Level A", "importance": "high", "effect_size": "large"}
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

        today = date.today().isoformat()
        prompt = f"""Find the latest clinical guidelines relevant to this query.
Target countries: {', '.join(countries)}
TODAY'S DATE: {today}

QUERY: {query}

SEARCH RESULTS:
{chr(10).join(search_context)}

IMPORTANT DATE RULES:
- Today is {today}. Only cite guidelines that are current as of this date.
- Prefer guidelines published within the last 2 years ({date.today().year - 1}–{date.today().year}).
- If multiple versions exist, ALWAYS cite the most recent one (e.g., "GINA 2024" not "GINA 2019").
- Include the year field for every guideline so the doctor can verify recency.

CRITICAL: For the "url" field in each guideline, copy the EXACT full URL from the search results above.
Do NOT shorten URLs to just the domain (e.g., do NOT write "https://ginasthma.org" if the full URL was
"https://ginasthma.org/2024-gina-report/"). Use the complete URL exactly as provided in the search results.

Synthesize the findings into structured JSON as specified."""

        try:
            result = await self.call_json(prompt)
            # Validate URLs — LLMs often shorten to base domains, replace with real search result URLs
            if isinstance(result, dict) and exa_results:
                result["guidelines"] = self._validate_urls(
                    result.get("guidelines", []), exa_results,
                )
            return result
        except Exception:
            raw = await self.call(prompt)
            return {"guidelines": [], "synthesis": raw, "disagreements": "N/A"}

    @staticmethod
    def _validate_urls(
        guidelines: list[dict], exa_results: list[dict[str, Any]],
    ) -> list[dict]:
        """Replace missing / base-domain URLs with verified search-result URLs."""
        from urllib.parse import urlparse

        clean_exa = [r for r in exa_results if r.get("url") and not r.get("error")]
        if not clean_exa:
            return guidelines

        exa_url_set = {r["url"] for r in clean_exa}

        for g in guidelines:
            url = g.get("url") or ""
            # Detect base-domain-only URLs (no real path)
            is_base = False
            if url:
                parsed = urlparse(url)
                is_base = parsed.path in ("", "/") or (len(parsed.path) < 5 and "." not in parsed.path)

            if not url or is_base or url not in exa_url_set:
                best = ResearchAgent._best_exa_match(g, clean_exa)
                if best and best.get("url"):
                    g["url"] = best["url"]
                    # Also sync year from published_date if missing
                    if not g.get("year") and best.get("published_date"):
                        try:
                            g["year"] = int(best["published_date"][:4])
                        except (ValueError, TypeError):
                            pass

        return guidelines

    @staticmethod
    def _best_exa_match(
        guideline: dict, exa_results: list[dict[str, Any]],
    ) -> dict[str, Any] | None:
        """Find the Exa result whose title best matches the guideline."""
        g_title = (guideline.get("title", "") + " " + guideline.get("source", "")).lower()
        g_words = set(w for w in g_title.split() if len(w) > 2)
        if not g_words:
            return None

        best, best_score = None, 0.0
        for r in exa_results:
            r_title = (r.get("title", "")).lower()
            r_words = set(w for w in r_title.split() if len(w) > 2)
            if not r_words:
                continue
            overlap = len(g_words & r_words)
            score = overlap / max(len(g_words), 1)
            if score > best_score and score > 0.25:
                best_score = score
                best = r

        return best
