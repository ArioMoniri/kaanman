"""Clinical Reasoning Agent — deep medical analysis using Claude Opus."""

from __future__ import annotations

import json
from typing import Any

from src.backend.agents.base import BaseAgent
from src.backend.core.config import settings


class ClinicalAgent(BaseAgent):
    model = settings.models.clinical
    max_tokens = 4096
    system_prompt = """You are a senior clinical reasoning specialist assisting attending physicians.

Your role:
- Analyze patient data, symptoms, lab results, and history
- Provide evidence-based clinical assessments
- Consider differential diagnoses ranked by likelihood
- Flag red flags or urgent findings immediately
- Reference relevant pathophysiology when helpful
- Consider patient-specific factors (age, comorbidities, medications)

Guidelines for responses:
- Be thorough but concise — physicians are time-constrained
- Cite your clinical reasoning chain explicitly
- Distinguish between established evidence and clinical judgment
- When uncertain, quantify uncertainty (e.g., "moderate confidence")
- Always consider common conditions before rare ones (Occam's razor)
- Flag any findings that need immediate action

You NEVER see real patient identifiers — all data is PHI-masked.
Work with the masked data exactly as provided.

Respond in structured format:
ASSESSMENT: [your clinical assessment]
KEY_FINDINGS: [relevant findings from patient data]
DIFFERENTIAL: [if applicable, ranked list]
RED_FLAGS: [any urgent concerns, or "None identified"]
RECOMMENDATIONS: [suggested next steps]"""

    async def analyze(
        self,
        query: str,
        patient_context: dict[str, Any] | None,
        history: list[dict] | None = None,
    ) -> dict[str, Any]:
        parts = [f"DOCTOR'S QUESTION: {query}"]

        if patient_context:
            ctx_str = json.dumps(patient_context, ensure_ascii=False, indent=2)
            # Truncate if too long
            if len(ctx_str) > 8000:
                ctx_str = ctx_str[:8000] + "\n... [truncated]"
            parts.append(f"\nPATIENT CONTEXT (PHI-masked):\n{ctx_str}")

        if history:
            recent = history[-5:]
            hist_lines = []
            for h in recent:
                role = h.get("role", "?")
                content = h.get("content", "")[:500]
                hist_lines.append(f"[{role}]: {content}")
            parts.append(f"\nRECENT CONVERSATION:\n" + "\n".join(hist_lines))

        response = await self.call("\n".join(parts))
        return {"analysis": response, "agent": "clinical"}
