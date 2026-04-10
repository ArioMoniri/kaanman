"""Router Agent — classifies incoming queries and decides which agents to activate.

Uses Claude Haiku for fast classification (<500ms target).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from src.backend.agents.base import BaseAgent
from src.backend.core.config import settings


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


class RouterAgent(BaseAgent):
    model = settings.models.router
    max_tokens = 512
    system_prompt = """You are a medical query router for a doctor assistant system.
Your job is to classify the doctor's question and decide which specialist agents to activate.

Classify into one of these categories:
- CLINICAL_REASONING: diagnosis, differential, interpretation of findings
- DRUG_DOSING: medication dosing, drug interactions, contraindications, prescribing
- GUIDELINE_LOOKUP: when the doctor asks about current guidelines or best practices
- LAB_INTERPRETATION: lab results analysis
- DIFFERENTIAL_DIAGNOSIS: differential diagnosis specifically
- TREATMENT_PLAN: treatment planning and recommendations
- EMERGENCY: urgent/critical findings
- GENERAL: general medical questions

For each query, decide:
1. Which agents to activate (clinical, research, drug)
2. Urgency level (1=routine, 2=important, 3=urgent, 4=critical, 5=emergency)
3. Whether patient context is needed
4. Which countries' guidelines are most relevant (e.g., ["USA", "UK", "Europe", "Turkey"])

RESPOND WITH ONLY JSON — no markdown, no explanation:
{
  "category": "...",
  "urgency": 2,
  "needs_clinical": true,
  "needs_research": false,
  "needs_drug": false,
  "needs_patient_context": false,
  "guideline_countries": ["USA", "Europe"],
  "reasoning": "brief one-line reason"
}"""

    async def classify(self, message: str, patient_context: dict[str, Any] | None = None) -> RouteDecision:
        ctx_hint = ""
        if patient_context:
            ctx_hint = "\n[Patient context is available for this session]"

        prompt = f"Doctor's question: {message}{ctx_hint}"

        try:
            data = await self.call_json(prompt)
            return RouteDecision(**{k: v for k, v in data.items() if k in RouteDecision.__dataclass_fields__})
        except Exception:
            return RouteDecision(
                category="CLINICAL_REASONING",
                needs_clinical=True,
                needs_research=True,
                reasoning="Router fallback — defaulting to clinical + research",
            )
