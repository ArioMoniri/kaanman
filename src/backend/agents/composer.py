"""Composer Agent — merges agent outputs into fast + complete answers.

Supports two-phase generation: fast answer first, then complete answer.
Includes consultation suggestions, emergency-first fast mode, and citations.
"""

from __future__ import annotations

import json
from typing import Any

from src.backend.agents.base import BaseAgent
from src.backend.agents.router import RouteDecision
from src.backend.api.schemas import Citation
from src.backend.core.config import settings


def _build_context(
    query: str,
    agent_outputs: dict[str, Any],
    patient_context: dict[str, Any] | None,
    route: RouteDecision,
    citations: list[Citation] | None = None,
) -> str:
    """Build the shared context prompt for both fast and complete composers."""
    parts = [
        f"ORIGINAL QUESTION: {query}",
        f"CATEGORY: {route.category} | URGENCY: {route.urgency}/5",
        f"LANGUAGE: {route.language} (respond in THIS language)",
    ]

    if citations:
        cite_lines = []
        for c in citations:
            line = f"[{c.index}] {c.source} — {c.title}"
            if c.year:
                line += f" ({c.year}, {c.country})"
            if c.url:
                line += f" URL: {c.url}"
            if c.quote:
                line += f" | Key: {c.quote}"
            cite_lines.append(line)
        parts.append(f"\nCITATION LIST (use [N] references in your answer):\n" + "\n".join(cite_lines))

    if patient_context:
        diagnoses = []
        episodes = patient_context.get("episodes", [])
        for ep in (episodes or [])[:5]:
            for d in (ep.get("diagnosis") or []):
                name = d.get("DiagnosisName", "")
                if name:
                    diagnoses.append(name)
        if diagnoses:
            parts.append(f"PATIENT DIAGNOSIS HISTORY: {'; '.join(diagnoses)}")
        else:
            parts.append("[Patient context is available — agents had access to it]")

    for agent_name, output in agent_outputs.items():
        if isinstance(output, dict):
            content = output.get("analysis") or output.get("synthesis") or json.dumps(output, ensure_ascii=False)
        else:
            content = str(output)
        if len(content) > 4000:
            content = content[:4000] + "\n... [truncated]"
        parts.append(f"\n--- {agent_name.upper()} AGENT OUTPUT ---\n{content}")

    return "\n".join(parts)


class FastComposer(BaseAgent):
    """Generates the fast answer only — optimized for speed."""
    model = settings.models.composer
    max_tokens = 1024
    system_prompt = r"""You are a medical response composer. Generate a FAST clinical answer (80-150 words).

RULES:
- Respond in the SAME LANGUAGE as the original question
- If urgency >= 4: Start with "CRITICAL:" followed by the single most important action
- If urgency < 4: Start with the key clinical finding
- 3-5 bullet points with the most actionable information
- Include key numbers (doses, lab thresholds, vitals targets)
- If calculations were performed, show the RESULT only (e.g., "CrCl = 45 mL/min → dose adjust")
- One-line "Bottom line:" summary
- If a consultation is warranted, add: "→ Consider [specialty] consult"
- Reference guidelines with [N] citation numbers when available
- NEVER include patient identifiers or real names
- Use hedging: "consider", "may warrant"

Return ONLY the answer text, no JSON wrapping."""


class CompleteComposer(BaseAgent):
    """Generates the complete answer — thorough analysis with LaTeX and citations."""
    model = settings.models.composer
    max_tokens = 6144
    system_prompt = r"""You are a medical response composer. Generate a COMPLETE clinical analysis (400-800 words).

RESPOND IN THE SAME LANGUAGE AS THE ORIGINAL QUESTION.

Structure:
1. **Assessment**: Clinical interpretation of the question + patient context
2. **Evidence & Guidelines**: Cite guidelines using [N] references from the CITATION LIST. Include country attribution (NICE/UK, AHA/USA, ESC/Europe, WHO).
3. **Calculations**: If the drug agent performed calculations, include the FULL LaTeX formulas and worked examples. Use $$ delimiters for LaTeX display math:
   $$CrCl = \frac{(140 - age) \times weight}{72 \times S_{cr}}$$
4. **Recommendations**: Specific, actionable next steps
5. **Consultation Advisory**: Check for cross-condition conflicts. Format: "Consultation suggested: [Specialty] — [reason]"
6. **Monitoring**: What to track and when
7. **References**: List each citation as "[N] Source — Title (Year, Country)" with URL if available

RULES:
- NEVER include patient identifiers or real names
- Preserve ALL LaTeX blocks with $$ delimiters — they must render correctly
- Use proper markdown formatting: **bold**, bullet points, tables with |---|
- For drug dosing, always include the dose RANGE, not a single number
- If agents disagree, present both perspectives

Return ONLY the answer text with markdown formatting, no JSON wrapping."""


class ComposerAgent:
    """Orchestrates fast and complete answer generation."""

    def __init__(self):
        self.fast_composer = FastComposer()
        self.complete_composer = CompleteComposer()
        self.last_usage = {"input_tokens": 0, "output_tokens": 0}

    async def compose_fast(
        self,
        query: str,
        agent_outputs: dict[str, Any],
        patient_context: dict[str, Any] | None,
        route: RouteDecision,
        citations: list[Citation] | None = None,
    ) -> str:
        """Generate fast answer only — called first for immediate streaming."""
        context = _build_context(query, agent_outputs, patient_context, route, citations)
        result = await self.fast_composer.call(context)
        self.last_usage = self.fast_composer.last_usage
        return result

    async def compose_complete(
        self,
        query: str,
        agent_outputs: dict[str, Any],
        patient_context: dict[str, Any] | None,
        route: RouteDecision,
        citations: list[Citation] | None = None,
    ) -> str:
        """Generate complete answer — called after fast answer is streamed."""
        context = _build_context(query, agent_outputs, patient_context, route, citations)
        result = await self.complete_composer.call(context)
        self.last_usage = self.complete_composer.last_usage
        return result
