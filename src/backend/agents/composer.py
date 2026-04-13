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
    lang_name = {
        "tr": "Turkish (Türkçe)", "en": "English", "de": "German (Deutsch)",
        "fr": "French (Français)", "es": "Spanish (Español)",
        "ar": "Arabic", "ru": "Russian", "zh": "Chinese",
    }.get(route.language, route.language)

    parts = [
        f"ORIGINAL QUESTION: {query}",
        f"CATEGORY: {route.category} | URGENCY: {route.urgency}/5",
        f"LANGUAGE: {route.language} — You MUST write your ENTIRE response in {lang_name}. "
        f"Every word, heading, bullet point, and recommendation must be in {lang_name}. "
        f"Do NOT mix languages. Do NOT respond in English unless the question is in English.",
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
        # Build detailed patient timeline with dates
        patient_info = patient_context.get("patient", patient_context)
        allergy = patient_info.get("allergy", {})
        if allergy and isinstance(allergy, dict):
            parts.append(f"PATIENT ALLERGY INFO: {json.dumps(allergy, ensure_ascii=False)}")

        episodes = patient_context.get("episodes", [])
        if episodes:
            timeline = []
            for ep in (episodes or [])[:15]:
                date = ep.get("date", "")
                service = ep.get("service_name", "")
                dx_list = []
                for d in (ep.get("diagnosis") or []):
                    name = d.get("DiagnosisName", "")
                    icd = d.get("ICDCode", "")
                    if name:
                        dx_list.append(f"{name} ({icd})" if icd else name)
                exam = (ep.get("examination_text") or "")[:300]
                entry = f"- {date} | {service}"
                if dx_list:
                    entry += f" | Dx: {', '.join(dx_list)}"
                if exam:
                    entry += f" | Notes: {exam[:200]}"
                timeline.append(entry)
            parts.append(f"\nPATIENT VISIT TIMELINE (newest first):\n" + "\n".join(timeline))
        else:
            parts.append("[Patient context is available — agents had access to it]")

        # Previous medications/recipes with dates and prescriber info
        recipes = patient_info.get("previous_recipes")
        if recipes and isinstance(recipes, list) and len(recipes) > 0:
            med_lines = []
            for rx in recipes[:15]:
                if isinstance(rx, dict):
                    med_name = (
                        rx.get("MedicineName")
                        or rx.get("medicine_name")
                        or rx.get("name")
                        or ""
                    )
                    rx_date = rx.get("TARIH", rx.get("date", ""))
                    rx_doc = rx.get("DR_ADI", rx.get("doctor", ""))
                    rx_episode = rx.get("RF_EPISODE", rx.get("episode_id", ""))
                    if med_name:
                        line = med_name
                        if rx_date:
                            line += f" (tarih: {rx_date}"
                            if rx_doc:
                                line += f", dr: {rx_doc}"
                            line += ")"
                        med_lines.append(line)
                    elif rx_date and rx_doc:
                        # Recipe without drug name — still include metadata
                        med_lines.append(f"Reçete {rx_date} — {rx_doc} (ep:{rx_episode})")
            if med_lines:
                parts.append(f"MEDICATIONS/RECIPES: {'; '.join(med_lines)}")

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
- If urgency >= 4: Start with "⚠️ CRITICAL:" followed by the single most important action
- If urgency < 4: Start with the key clinical finding
- 3-5 bullet points with the most actionable information
- Include key numbers (doses, lab thresholds, vitals targets)
- If calculations were performed, show the RESULT only (e.g., "CrCl = 45 mL/min → dose adjust")
- One-line "Bottom line:" summary
- If a consultation is warranted, add: "→ Consider [specialty] consult"
- Reference guidelines with [N] citation numbers when available
- NEVER include patient identifiers or real names — use [PATIENT_NAME] if needed
- If the doctor asks for the patient's name (e.g., "adı ne?", "hastanın adı", "what is the patient's name?"), EXPLICITLY explain: "Patient names are PHI (Protected Health Information) and are masked for privacy compliance. The patient is identified by their protocol number." — in the same language as the query.
- Use hedging: "consider", "may warrant"

PRESCRIPTION / Rx SECTION:
- If the question involves drug recommendations, prescriptions, or treatment — ALWAYS include a dedicated "## Rx" section at the end
- Format each drug as a numbered list with: drug name (active ingredient), dose, route, frequency, duration
- If a prescription agent provided brand names, use those EXACT brand names
- Include ICD-10 code for each prescribed item when available
- This section is critical — doctors will copy it directly as a prescription

CRITICAL ALERTS:
- If you detect a major contraindication, serious drug interaction, or life-threatening condition, mark it with: "⚠️ ALERT:" at the start of that bullet point
- Mark dangerous combinations, allergies conflicting with prescribed drugs, or red-flag symptoms

PATIENT HISTORY DATES:
- When mentioning anything from patient history (medications, procedures, diagnoses, lab results), ALWAYS include the DATE it occurred (e.g., "Hepatit B tanısı (03.07.2024)", "Kardiyoloji kontrolü (23.02.2026)")
- Never say "previously" or "before" without a specific date

ICD CODES:
- When mentioning any ICD code, ALWAYS write the disease name in parentheses after the code
- Example: "J45.9 (Astım)", "H40.1 (Primer Açık Açılı Glokom)", "M45 (Ankilozan Spondilit)"
- Never write a bare ICD code without its description

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
7. **References**: List each citation as "[N] Source — *Title* (Year, Country) — URL" with the URL as a markdown link

CRITICAL ALERTS:
- If there is a major contraindication, dangerous drug interaction, life-threatening condition, or allergy conflict: write a line starting with "⚠️ ALERT:" explaining the danger. These will be visually highlighted to the doctor.
- Examples: "⚠️ ALERT: Patient has HBV — immunosuppressive drugs require hepatitis reactivation monitoring"

PATIENT HISTORY DATES:
- When referencing anything from the patient's history (past diagnoses, medications taken, surgeries, lab results, visits), ALWAYS include the specific DATE (e.g., "HBV serokonversiyonu saptanmış (03.07.2024 — İç Hastalıkları)")
- Include the department/specialty where it was found when available
- Never say "previously diagnosed" without giving the date and context

ICD CODES:
- When mentioning any ICD code, ALWAYS write the disease/condition name in parentheses after the code
- Example: "J45.9 (Astım)", "H40.1 (Primer Açık Açılı Glokom)", "M45 (Ankilozan Spondilit)", "B18.1 (Kronik Viral Hepatit B)"
- Never write a bare ICD code without its description

PRESCRIPTION / Rx SECTION:
- If the question involves drug recommendations, prescriptions, or treatment — ALWAYS include a dedicated "## Rx" section
- Format each drug as a numbered list: drug name (active ingredient), dose, route, frequency, duration, ICD-10 code
- If a prescription agent provided brand names, use those EXACT brand names
- If brand options are provided, list them as "Choose one: 1) BRAND_A  2) BRAND_B  3) BRAND_C"
- This section is critical — doctors will copy it directly as a prescription

RULES:
- NEVER include patient identifiers or real names — use [PATIENT_NAME] if needed
- If the doctor asks for the patient's name (e.g., "adı ne?", "hastanın adı", "what is the patient's name?"), EXPLICITLY explain: "Patient names are PHI (Protected Health Information) and are masked for privacy compliance. The patient is identified by their protocol number." — in the same language as the query.
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
