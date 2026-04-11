"""Trust Scorer Agent — evaluates response confidence across 6 dimensions.

Each dimension gets a score AND a one-line reasoning explanation.
The reasoning is shown to the user on hover over the speedometer gauge.
"""

from __future__ import annotations

import json
from typing import Any

from src.backend.agents.base import BaseAgent
from src.backend.core.config import settings


class TrustScorerAgent(BaseAgent):
    model = settings.models.trust
    max_tokens = 1024
    system_prompt = """You evaluate medical AI responses and produce trust scores across 6 dimensions.

For EACH dimension, provide a score (0-100) AND a one-line reasoning explaining WHY you gave that score. The reasoning must reference specific content from the answer — never give generic or placeholder text.

Dimensions:

1. **evidence_quality** (0-100): Is the answer supported by strong clinical evidence?
   - 90-100: Randomized controlled trials, systematic reviews cited
   - 70-89: Large observational studies, well-established practice
   - 50-69: Case series, expert consensus
   - <50: Limited evidence, theoretical reasoning

2. **guideline_alignment** (0-100): Does the answer align with current clinical guidelines?
   - 90-100: Directly supported by current guidelines with citations
   - 70-89: Consistent with guidelines but not directly cited
   - 50-69: Partially aligned, some guideline gaps
   - <50: No guideline support or contradicts guidelines

3. **clinical_relevance** (0-100): How directly applicable is this to the clinical question?
   - 90-100: Directly answers with actionable information
   - 70-89: Relevant but requires some interpretation
   - <70: Tangential or overly general

4. **safety_check** (0-100): Are safety considerations adequately addressed?
   - 90-100: All contraindications, interactions, red flags covered
   - 70-89: Most safety issues addressed
   - <70: Missing important safety considerations

5. **completeness** (0-100): How thorough is the response?
   - 90-100: All aspects addressed comprehensively
   - 70-89: Main points covered, some gaps
   - <70: Significant gaps

6. **source_recency** (0-100): How current are the sources/guidelines cited?
   - 90-100: Guidelines from last 2 years
   - 70-89: Guidelines from last 3-5 years
   - 50-69: Older guidelines but still valid
   - <50: Outdated or no sources cited

CRITICAL — NON-ANSWER DETECTION:
If the response essentially says it cannot access patient data, cannot find relevant information, provides only generic disclaimers, or does NOT actually answer the clinical question asked, ALL dimension scores MUST be LOW (0-25). A well-written non-answer is still a non-answer. Score the USEFULNESS of the response to the doctor, not its linguistic quality.

Indicators of a non-answer:
- "I cannot access", "data unavailable", "unable to retrieve"
- Generic safety disclaimers without specific clinical guidance
- Repeating the question without providing a real answer
- Suggesting to "consult a physician" without any clinical analysis

Also assess your own confidence in this evaluation (0-100). Consider: did the answer contain enough detail for you to evaluate properly? Could you verify the claims?

RESPOND WITH ONLY JSON:
{
  "evidence_quality": {"score": N, "reason": "one-line reason referencing specific content"},
  "guideline_alignment": {"score": N, "reason": "one-line reason"},
  "clinical_relevance": {"score": N, "reason": "one-line reason"},
  "safety_check": {"score": N, "reason": "one-line reason"},
  "completeness": {"score": N, "reason": "one-line reason"},
  "source_recency": {"score": N, "reason": "one-line reason"},
  "scorer_confidence": 85
}"""

    async def score(
        self,
        query: str,
        fast_answer: str,
        complete_answer: str,
        agent_outputs: dict[str, Any],
    ) -> dict[str, Any]:
        prompt = f"""Score this medical AI response:

QUESTION: {query}

FAST ANSWER:
{fast_answer[:1000]}

COMPLETE ANSWER:
{complete_answer[:3000]}

SOURCES USED: {list(agent_outputs.keys())}"""

        try:
            raw = await self.call_json(prompt)

            scores: dict[str, int] = {}
            reasons: dict[str, str] = {}
            dim_keys = (
                "evidence_quality", "guideline_alignment", "clinical_relevance",
                "safety_check", "completeness", "source_recency",
            )
            for k in dim_keys:
                val = raw.get(k, {})
                if isinstance(val, dict):
                    scores[k] = max(0, min(100, int(val.get("score", 50))))
                    reasons[k] = val.get("reason", "")
                elif isinstance(val, (int, float)):
                    scores[k] = max(0, min(100, int(val)))
                    reasons[k] = ""
                else:
                    scores[k] = 0
                    reasons[k] = "Dimension not evaluated"

            scorer_confidence = max(0, min(100, int(raw.get("scorer_confidence", 70))))

            return {
                "scores": scores,
                "reasons": reasons,
                "scorer_confidence": scorer_confidence,
            }
        except Exception as e:
            default_scores = {k: 0 for k in (
                "evidence_quality", "guideline_alignment", "clinical_relevance",
                "safety_check", "completeness", "source_recency",
            )}
            error_msg = str(e) if str(e) else "Unknown scoring error"
            return {
                "scores": default_scores,
                "reasons": {k: f"Scorer failed: {error_msg}" for k in default_scores},
                "scorer_confidence": 0,
            }
