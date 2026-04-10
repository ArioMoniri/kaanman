"""Trust Scorer Agent — evaluates response confidence across 6 dimensions."""

from __future__ import annotations

import json
from typing import Any

from src.backend.agents.base import BaseAgent
from src.backend.core.config import settings


class TrustScorerAgent(BaseAgent):
    model = settings.models.trust
    max_tokens = 512
    system_prompt = """You evaluate medical AI responses and produce trust scores across 6 dimensions.

Score each dimension from 0-100:

1. **evidence_quality** (0-100): Is the answer supported by strong clinical evidence?
   - 90-100: Randomized controlled trials, systematic reviews
   - 70-89: Large observational studies, well-established practice
   - 50-69: Case series, expert consensus
   - <50: Limited evidence, theoretical reasoning

2. **guideline_alignment** (0-100): Does the answer align with current clinical guidelines?
   - 90-100: Directly supported by current guidelines with citations
   - 70-89: Consistent with guidelines but not directly cited
   - 50-69: Partially aligned, some guideline gaps
   - <50: No guideline support or contradicts guidelines

3. **clinical_relevance** (0-100): How directly applicable is this to the clinical question?
   - 90-100: Directly answers the question with actionable information
   - 70-89: Relevant but requires some interpretation
   - <70: Tangential or overly general

4. **safety_check** (0-100): Are safety considerations adequately addressed?
   - 90-100: All contraindications, interactions, red flags covered
   - 70-89: Most safety issues addressed
   - <70: Missing important safety considerations

5. **completeness** (0-100): How thorough is the response?
   - 90-100: All aspects of the question addressed comprehensively
   - 70-89: Main points covered, some gaps
   - <70: Significant gaps in coverage

6. **source_recency** (0-100): How current are the sources/guidelines cited?
   - 90-100: Guidelines from last 2 years
   - 70-89: Guidelines from last 3-5 years
   - 50-69: Older guidelines but still valid
   - <50: Outdated or no sources cited

RESPOND WITH ONLY JSON — no markdown, no explanation:
{"evidence_quality": N, "guideline_alignment": N, "clinical_relevance": N, "safety_check": N, "completeness": N, "source_recency": N}"""

    async def score(
        self,
        query: str,
        fast_answer: str,
        complete_answer: str,
        agent_outputs: dict[str, Any],
    ) -> dict[str, int]:
        prompt = f"""Score this medical AI response:

QUESTION: {query}

FAST ANSWER:
{fast_answer[:1000]}

COMPLETE ANSWER:
{complete_answer[:2000]}

SOURCES USED: {list(agent_outputs.keys())}"""

        try:
            scores = await self.call_json(prompt)
            # Clamp all values to 0-100
            return {
                k: max(0, min(100, int(v)))
                for k, v in scores.items()
                if k in ("evidence_quality", "guideline_alignment", "clinical_relevance",
                         "safety_check", "completeness", "source_recency")
            }
        except Exception:
            return {
                "evidence_quality": 50,
                "guideline_alignment": 50,
                "clinical_relevance": 50,
                "safety_check": 50,
                "completeness": 50,
                "source_recency": 50,
            }
