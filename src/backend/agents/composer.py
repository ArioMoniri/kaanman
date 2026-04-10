"""Composer Agent — merges agent outputs into fast + complete answers.

Includes consultation suggestions and emergency-first fast mode.
"""

from __future__ import annotations

import json
from typing import Any

from src.backend.agents.base import BaseAgent
from src.backend.agents.router import RouteDecision
from src.backend.api.schemas import Citation
from src.backend.core.config import settings


class ComposerAgent(BaseAgent):
    model = settings.models.composer
    max_tokens = 6144
    system_prompt = r"""You are a medical response composer for a doctor assistant system.

You receive outputs from specialist agents and compose TWO answer versions.
Both serve different needs — the fast answer may save a life in an emergency.

## FAST MODE (target: 80-150 words) — LIGHTNING RESPONSE
Purpose: Give the doctor an immediate actionable snapshot, especially critical in emergencies.

Structure:
- **If urgency >= 4**: Start with "⚠ CRITICAL:" followed by the single most important action
- **If urgency < 4**: Start with the key clinical finding
- 3-5 bullet points with the most actionable information
- Include key numbers (doses, lab thresholds, vitals targets)
- If calculations were performed, show the RESULT only (e.g., "CrCl = 45 mL/min → dose adjust")
- One-line "Bottom line:" summary
- If a consultation is warranted, add: "→ Consider [specialty] consult"

## COMPLETE MODE (target: 400-800 words) — FULL ANALYSIS
Structure:
1. **Assessment**: Clinical interpretation of the question + patient context
2. **Evidence & Guidelines**: Cite guidelines with country attribution using numbered references like [1], [2]. Use the CITATION LIST provided below to match references. Example: "According to the NICE 2024 guideline [1], first-line therapy is..."
3. **Calculations**: If the drug agent performed calculations, include the FULL LaTeX formulas and worked examples. Preserve all $$ LaTeX blocks $$ exactly as provided by the drug agent.
4. **Recommendations**: Specific, actionable next steps
5. **Consultation Advisory**: See below
6. **Monitoring**: What to track and when
7. **References**: List each citation as "[N] Source — Title (Year, Country)"

## CONSULTATION ADVISORY (include in BOTH modes when applicable)

You MUST check for cross-condition conflicts and suggest consultations when:
- A prescribed medication conflicts with an existing condition in patient history
  (e.g., beta-blocker prescribed but patient has asthma → Pulmonology consult)
- A drug has significant interactions with medications from another specialty
  (e.g., anticoagulant + NSAID → Hematology/GI consult)
- A diagnosis spans multiple specialties
  (e.g., diabetic nephropathy → Endocrine + Nephrology)
- Patient history reveals a condition that may complicate the current treatment
  (e.g., glaucoma suspect + anticholinergic drug → Ophthalmology consult)
- Dose adjustment needed due to comorbidity managed by another department

Format consultation suggestions as:
"📋 Consultation suggested: [Specialty] — [reason in one line]"

## RULES
- NEVER include patient identifiers or PHI
- Preserve ALL LaTeX blocks ($$ ... $$) from the drug agent output — pass them through exactly
- Use hedging language: "consider", "recommend evaluation for", "may warrant"
- For drug dosing, always include the dose RANGE, not a single number
- If agents disagree, present both perspectives
- If urgency >= 4, the fast answer must be immediately actionable without reading the complete version

Respond with JSON:
{
  "fast": "the fast mode answer (plain text, no LaTeX except result numbers)",
  "complete": "the complete mode answer (may include $$ LaTeX blocks $$)"
}"""

    async def compose(
        self,
        query: str,
        agent_outputs: dict[str, Any],
        patient_context: dict[str, Any] | None,
        route: RouteDecision,
        citations: list[Citation] | None = None,
    ) -> dict[str, str]:
        parts = [
            f"ORIGINAL QUESTION: {query}",
            f"CATEGORY: {route.category} | URGENCY: {route.urgency}/5",
        ]

        if citations:
            cite_lines = []
            for c in citations:
                line = f"[{c.index}] {c.source} — {c.title}"
                if c.year:
                    line += f" ({c.year}, {c.country})"
                if c.quote:
                    line += f" | Key: {c.quote}"
                cite_lines.append(line)
            parts.append(f"\nCITATION LIST (use [N] references in your answer):\n" + "\n".join(cite_lines))

        if patient_context:
            # Summarize patient context for consultation checking
            diagnoses = []
            episodes = patient_context.get("episodes", [])
            for ep in (episodes or [])[:5]:
                for d in (ep.get("diagnosis") or []):
                    name = d.get("DiagnosisName", "")
                    if name:
                        diagnoses.append(name)
            if diagnoses:
                parts.append(f"PATIENT DIAGNOSIS HISTORY (for consultation check): {'; '.join(diagnoses)}")
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
