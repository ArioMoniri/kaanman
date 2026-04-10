"""Decision Tree Agent — generates clinical decision trees as React Flow JSON.

Only invoked when the router flags the query as needing a decision tree
(e.g., treatment algorithms, diagnostic pathways, drug selection flows).
"""

from __future__ import annotations

import json
from typing import Any

from src.backend.agents.base import BaseAgent
from src.backend.core.config import settings


class DecisionTreeAgent(BaseAgent):
    model = settings.models.clinical
    max_tokens = 4096
    system_prompt = r"""You are a clinical decision tree generator. Given a medical query and agent outputs, produce a structured decision tree in React Flow JSON format.

The decision tree should represent the clinical decision pathway — e.g., diagnostic workup, treatment algorithm, drug selection criteria.

## OUTPUT FORMAT

Return ONLY valid JSON with this structure:
{
  "title": "Decision tree title",
  "nodes": [
    {"id": "1", "type": "input", "data": {"label": "Start: Patient presents with X"}, "position": {"x": 250, "y": 0}},
    {"id": "2", "type": "default", "data": {"label": "Check: Contraindications?"}, "position": {"x": 250, "y": 100}},
    {"id": "3", "type": "default", "data": {"label": "Yes: Switch to alternative"}, "position": {"x": 100, "y": 200}},
    {"id": "4", "type": "default", "data": {"label": "No: Proceed with drug"}, "position": {"x": 400, "y": 200}},
    {"id": "5", "type": "output", "data": {"label": "Dose: 25-50mg/day PO"}, "position": {"x": 400, "y": 300}}
  ],
  "edges": [
    {"id": "e1-2", "source": "1", "target": "2", "label": "assess"},
    {"id": "e2-3", "source": "2", "target": "3", "label": "yes"},
    {"id": "e2-4", "source": "2", "target": "4", "label": "no"},
    {"id": "e4-5", "source": "4", "target": "5", "label": "initiate"}
  ]
}

## RULES
- Use "input" type for the first node (entry point)
- Use "output" type for terminal/action nodes (final recommendations)
- Use "default" type for decision/branch nodes
- Edge labels should be concise (yes/no, condition names)
- Position nodes in a top-down tree layout (increment y by ~100 per level)
- Branch left for "yes"/"positive" paths, right for "no"/"negative" paths
- Include dosing, monitoring, and referral endpoints where appropriate
- Keep node labels under 60 characters
- Maximum 15 nodes for readability
- Respond in the same language as the original question"""

    async def generate(
        self,
        query: str,
        agent_outputs: dict[str, Any],
        patient_context: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        parts = [f"CLINICAL QUESTION: {query}"]

        if patient_context:
            parts.append("[Patient context available — include patient-specific branches]")

        for name, output in agent_outputs.items():
            if isinstance(output, dict):
                content = output.get("analysis", output.get("synthesis", ""))
            else:
                content = str(output)
            if len(content) > 2000:
                content = content[:2000]
            parts.append(f"\n--- {name.upper()} OUTPUT ---\n{content}")

        parts.append("\nGenerate a clinical decision tree for this scenario.")

        try:
            result = await self.call_json("\n".join(parts))
            if "nodes" in result and "edges" in result:
                return result
            return None
        except Exception:
            return None
