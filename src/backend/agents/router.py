"""Router Agent — classifies incoming queries, enforces guardrails.

Uses Claude Haiku for fast classification (<500ms target).
Detects: medical vs non-medical, protocol IDs, language, urgency.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from src.backend.agents.base import BaseAgent
from src.backend.core.config import settings

_PROTOCOL_RE = re.compile(r"\b(\d{7,9})\b")


@dataclass
class RouteDecision:
    category: str = "GENERAL"
    urgency: int = 2
    needs_clinical: bool = True
    needs_research: bool = False
    needs_drug: bool = False
    needs_patient_context: bool = False
    guideline_countries: list[str] = field(default_factory=lambda: ["USA", "Europe"])
    reasoning: str = ""
    is_medical: bool = True
    direct_response: str = ""
    detected_protocol_id: str = ""
    language: str = "en"


class RouterAgent(BaseAgent):
    model = settings.models.router
    max_tokens = 512
    system_prompt = """You are a medical query router and guardrail for a doctor assistant system.

## STEP 1: GUARDRAIL — Is this a medical question?

Classify the input into one of:
- "MEDICAL" — any clinical, pharmacological, diagnostic, treatment, or health question
- "GREETING" — greetings like "hello", "hi", "merhaba", "selam", small talk
- "OFF_TOPIC" — non-medical: politics, recipes, coding, math, jokes, etc.

For GREETING: set is_medical=false, provide a warm direct_response in the SAME LANGUAGE as the input.
  Example (Turkish): "Merhaba! Size nasıl yardımcı olabilirim? Klinik sorularınızı bekliyorum."
  Example (English): "Hello! How can I help you? I'm ready for your clinical questions."

For OFF_TOPIC: set is_medical=false, provide a polite redirect in the SAME LANGUAGE.
  Example: "I'm a medical assistant and can only help with clinical questions. Please ask a medical question."
  Turkish: "Ben bir tıbbi asistanım ve yalnızca klinik sorulara yardımcı olabilirim. Lütfen tıbbi bir soru sorun."

For MEDICAL: proceed to Step 2.

## STEP 2: MEDICAL CLASSIFICATION

Classify into one of:
- CLINICAL_REASONING: diagnosis, differential, interpretation of findings
- DRUG_DOSING: medication dosing, drug interactions, contraindications, prescribing
- GUIDELINE_LOOKUP: current guidelines or best practices
- LAB_INTERPRETATION: lab results analysis
- TREATMENT_PLAN: treatment planning and recommendations
- EMERGENCY: urgent/critical findings
- GENERAL: general medical questions

## STEP 3: DETECT LANGUAGE

Detect the language of the input:
- "tr" for Turkish
- "en" for English
- "mixed" for mixed Turkish/English

## RESPOND WITH ONLY JSON:
{
  "is_medical": true,
  "category": "DRUG_DOSING",
  "urgency": 2,
  "needs_clinical": true,
  "needs_research": false,
  "needs_drug": false,
  "needs_patient_context": false,
  "guideline_countries": ["USA", "Europe"],
  "language": "tr",
  "direct_response": "",
  "reasoning": "brief one-line reason"
}"""

    async def classify(self, message: str, patient_context: dict[str, Any] | None = None) -> RouteDecision:
        # Pre-extract protocol ID before sending to LLM
        protocol_match = _PROTOCOL_RE.search(message)
        detected_protocol = protocol_match.group(1) if protocol_match else ""

        ctx_hint = ""
        if patient_context:
            ctx_hint = "\n[Patient context is available for this session]"

        prompt = f"Doctor's input: {message}{ctx_hint}"

        try:
            data = await self.call_json(prompt)
            valid_fields = set(RouteDecision.__dataclass_fields__.keys())
            filtered = {k: v for k, v in data.items() if k in valid_fields}
            decision = RouteDecision(**filtered)
        except Exception:
            decision = RouteDecision(
                category="CLINICAL_REASONING",
                needs_clinical=True,
                needs_research=True,
                reasoning="Router fallback — defaulting to clinical + research",
            )

        decision.detected_protocol_id = detected_protocol
        return decision
