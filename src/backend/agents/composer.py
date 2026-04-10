"""Composer Agent — merges agent outputs into fast + complete answers."""

from __future__ import annotations

import json
from typing import Any

from src.backend.agents.base import BaseAgent
from src.backend.agents.router import RouteDecision
from src.backend.core.config import settings


class ComposerAgent(BaseAgent):
    model = settings.models.composer
    max_tokens = 4096
    system_prompt = """You are a medical response composer for a doctor assistant system.

You receive outputs from multiple specialist agents (clinical reasoning, research/guidelines, drug/dosing) and compose two versions of the final answer:

**FAST MODE** (target: 80-150 words):
- 3-5 bullet points with the most actionable information
- Lead with the most critical finding or recommendation
- Include key numbers (doses, values, thresholds)
- End with one-line "Bottom line" summary

**COMPLETE MODE** (target: 400-800 words):
- Structured sections: Assessment | Evidence & Guidelines | Recommendations | Monitoring | References
- Cite which guidelines support each recommendation (with country: UK/USA/Europe)
- Include differential considerations when relevant
- Note areas of uncertainty or conflicting evidence
- Provide specific next-step actions

Rules:
- NEVER include patient identifiers or PHI
- Use hedging language appropriately ("consider", "recommend evaluation for")
- Always include relevant guideline sources with country attribution
- If agents disagree, present both perspectives with your synthesis
- For drug dosing, always include the dose range, not just a single number

Respond with JSON:
{
  "fast": "the fast mode answer",
  "complete": "the complete mode answer"
}"""

    async def compose(
        self,
        query: str,
        agent_outputs: dict[str, Any],
        patient_context: dict[str, Any] | None,
        route: RouteDecision,
    ) -> dict[str, str]:
        parts = [
            f"ORIGINAL QUESTION: {query}",
            f"CATEGORY: {route.category} | URGENCY: {route.urgency}/5",
        ]

        if patient_context:
            parts.append("[Patient context is available — agents had access to it]")

        for agent_name, output in agent_outputs.items():
            if isinstance(output, dict):
                content = output.get("analysis") or output.get("synthesis") or json.dumps(output, ensure_ascii=False)
            else:
                content = str(output)
            # Truncate very long outputs
            if len(content) > 3000:
                content = content[:3000] + "\n... [truncated]"
            parts.append(f"\n--- {agent_name.upper()} AGENT OUTPUT ---\n{content}")

        prompt = "\n".join(parts)

        try:
            result = await self.call_json(prompt)
            return {
                "fast": result.get("fast", "Unable to compose fast answer."),
                "complete": result.get("complete", "Unable to compose complete answer."),
            }
        except Exception:
            raw = await self.call(prompt)
            return {"fast": raw[:500], "complete": raw}
