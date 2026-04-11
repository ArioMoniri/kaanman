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

PATIENT-RECORD QUESTIONS (CRITICAL — these are scored VERY differently):
When the question asks about patient records, history, labs, medications, episodes, or hospitalization details — scoring criteria CHANGE FUNDAMENTALLY:

- evidence_quality: Score 80-95 when the answer accurately cites specific data from patient records (lab values with numbers, dates, diagnoses with ICD codes, medication names). The "evidence" IS the patient record data itself — external RCTs are NOT needed. Only score low if the data citations look fabricated or incomplete.
- guideline_alignment: Score 70-85 as long as data is presented in a clinically useful way. Guideline alignment is NOT a primary criterion for data retrieval. Score 50+ even for basic data presentation.
- clinical_relevance: Score 85-100 if the answer directly addresses what the doctor asked about the patient. This should almost always be high for record-retrieval questions.
- safety_check: Score 75-90 if relevant safety notes are mentioned (abnormal values flagged, drug interactions noted). For simple data retrieval, score 70+.
- completeness: Score based on whether ALL relevant patient data for the question was included. If the answer shows lab values, dates, and context — score 80+.
- source_recency: Score based on how RECENT the patient records themselves are. If citing recent episodes/labs, score 80+. This is about RECORD dates, not guideline dates.

HOW TO DETECT patient-record questions:
- The answer contains specific numerical lab values (e.g., "Hemoglobin: 12.3 g/dL")
- The answer references specific dates from patient history
- The answer mentions episode IDs, department visits, hospitalization details
- The answer lists specific medications from the patient's prescription
- Keywords: "kayıt", "sonuç", "değer", "rapor", "tetkik", "muayene", "episode", "lab", "test result", "record"
- The question context includes patient context data

IMPORTANT: Do NOT penalize patient-record answers for lacking external evidence or guideline citations. A factual, accurate data retrieval IS high-quality evidence when answering "what are the results?"

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
        # Detect if this is a patient-record-focused question
        has_patient = "patient_context" in agent_outputs or "patient" in agent_outputs
        patient_hint = ""
        if has_patient:
            # Check if the answer references specific patient data
            answer_lower = complete_answer.lower()
            query_lower = query.lower()
            record_indicators = [
                "lab", "test", "mg/dl", "g/dl", "mmol", "x10", "normal",
                "elevated", "decreased", "hospitalization", "episode",
                "medication", "prescription", "diagnosis", "icd",
                "report", "radyoloji", "muayene", "laboratuvar",
                "kayıt", "sonuç", "değer", "tarih", "tetkik",
                "hemoglobin", "lökosit", "trombosit", "kreatinin",
                "yatış", "poliklinik", "reçete", "hastane",
            ]
            query_record_words = [
                "nesi var", "durumu", "hastanın", "sonuçlar", "tetkik",
                "lab", "rapor", "ilaç", "muayene", "history", "results",
                "medications", "episodes", "diagnosis", "what does",
                "tell me about", "show me", "records", "data",
            ]
            answer_score = sum(1 for ind in record_indicators if ind in answer_lower)
            query_score = sum(1 for qw in query_record_words if qw in query_lower)
            is_record_q = answer_score >= 2 or query_score >= 1
            if is_record_q:
                patient_hint = (
                    "\n\n*** IMPORTANT: This is a PATIENT-RECORD question. "
                    "The answer is based on imported patient data (lab values, episodes, medications, diagnoses). "
                    "Apply PATIENT-RECORD scoring criteria — score HIGH for accurate data retrieval. "
                    "Do NOT penalize for lacking external guidelines or RCTs. ***"
                )

        prompt = f"""Score this medical AI response:

QUESTION: {query}

FAST ANSWER:
{fast_answer[:1000]}

COMPLETE ANSWER:
{complete_answer[:3000]}

SOURCES USED: {list(agent_outputs.keys())}{patient_hint}"""

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
