"""Episodes Agent — summarizes hospitalization/outpatient episodes and answers questions.

Joins the orchestrator council when episode data is available.
Provides clinical context from yatış (hospitalization) and poliklinik (outpatient) visits.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from src.backend.agents.base import BaseAgent
from src.backend.core.config import settings
from src.backend.tools.episodes_rag import (
    search_episodes,
    get_episodes_summary,
    store_episodes_summary,
)

log = logging.getLogger("cerebralink.agents.episodes")

_MAX_EPISODE_CHARS = 60_000


class EpisodesAgent(BaseAgent):
    model = settings.models.briefer
    max_tokens = 4096
    system_prompt = """You are a clinical episode analysis specialist. You analyze patient hospitalization records
(yatış) and outpatient visits (poliklinik) to provide temporal clinical context for doctors.

RULES:
- Summarize key hospitalizations with admission/discharge dates, reasons, and outcomes
- Track the patient's clinical journey across outpatient visits
- Highlight patterns: recurring conditions, escalating symptoms, treatment changes
- Note cross-references between episodes and any associated reports or tests
- Flag readmissions or short intervals between hospitalizations
- Group findings chronologically and by clinical significance
- Respond in the SAME LANGUAGE as the query
- Reference specific dates, departments, and doctors when citing findings
"""

    async def generate_summary(
        self,
        protocol_id: str,
        manifest: list[dict],
        episodes_dir: str,
        language: str = "en",
    ) -> str:
        """Generate a comprehensive episode summary from all episode data.

        Reads episode metadata (diagnoses, complaints, yatış details) and
        calls the LLM to produce a clinical episode timeline.
        """
        from pathlib import Path

        # Separate yatış and poliklinik episodes
        yatis_eps = [e for e in manifest if e.get("is_hospitalization")]
        poli_eps = [e for e in manifest if not e.get("is_hospitalization")]

        # Build content sections
        sections: list[str] = []
        total_chars = 0

        # Yatış episodes (priority — read full text)
        if yatis_eps:
            sections.append(f"## Hospitalizations ({len(yatis_eps)} yatış episodes)")
            for ep in yatis_eps:
                yb = ep.get("yatis_bilgisi", {})
                header = (
                    f"### Yatış: {ep.get('date', '')} — {ep.get('service_text', '')} "
                    f"@ {ep.get('facility_text', '')} — {ep.get('doctor_name', '')}\n"
                    f"Admission: {yb.get('yatis_tarihi', 'N/A')} | "
                    f"Discharge: {yb.get('taburcu_tarihi', 'N/A')}\n"
                    f"Reason: {yb.get('yatis_sebebi', 'N/A')} | "
                    f"Diagnosis: {yb.get('yatis_tanisi', 'N/A')}"
                )

                # Diagnoses
                diags = ep.get("diagnoses", [])
                if diags:
                    header += "\nDiagnoses: " + ", ".join(
                        f"{d.get('name', '')} ({d.get('icd_code', '')})"
                        for d in diags
                    )

                # Complaints
                complaints = ep.get("complaints", [])
                if complaints:
                    header += "\nComplaints: " + "; ".join(
                        c.get("title", "") for c in complaints
                    )

                # Read text file if available
                output_file = ep.get("output_file", "")
                text_content = ""
                if output_file:
                    txt_path = Path(episodes_dir) / output_file
                    if txt_path.exists():
                        try:
                            with open(txt_path, "r", encoding="utf-8") as f:
                                text_content = f.read()
                        except Exception:
                            pass

                remaining = _MAX_EPISODE_CHARS - total_chars
                if remaining <= 200:
                    break

                entry_text = header
                if text_content:
                    max_text = min(len(text_content), remaining - len(header) - 50)
                    if max_text > 0:
                        entry_text += "\n\n" + text_content[:max_text]

                sections.append(entry_text)
                total_chars += len(entry_text)

        # Poliklinik episodes (summarize metadata, read text for recent ones)
        if poli_eps:
            sections.append(f"\n## Outpatient Visits ({len(poli_eps)} poliklinik episodes)")

            # Read full text for recent 10 poli episodes, metadata for the rest
            for idx, ep in enumerate(poli_eps):
                remaining = _MAX_EPISODE_CHARS - total_chars
                if remaining <= 200:
                    sections.append(f"... ({len(poli_eps) - idx} more poliklinik episodes)")
                    break

                header = (
                    f"### Poli: {ep.get('date', '')} — {ep.get('service_text', '')} "
                    f"@ {ep.get('facility_text', '')} — {ep.get('doctor_name', '')}"
                )

                diags = ep.get("diagnoses", [])
                if diags:
                    header += "\nDx: " + ", ".join(
                        f"{d.get('name', '')} ({d.get('icd_code', '')})"
                        for d in diags
                    )

                complaints = ep.get("complaints", [])
                if complaints:
                    header += "\nCC: " + "; ".join(
                        c.get("title", "") for c in complaints
                    )

                # Read text for the first 10 episodes
                if idx < 10:
                    output_file = ep.get("output_file", "")
                    if output_file:
                        txt_path = Path(episodes_dir) / output_file
                        if txt_path.exists():
                            try:
                                with open(txt_path, "r", encoding="utf-8") as f:
                                    text = f.read()
                                if text.strip():
                                    max_text = min(len(text), remaining - len(header) - 50, 2000)
                                    if max_text > 0:
                                        header += "\n" + text[:max_text]
                            except Exception:
                                pass

                sections.append(header)
                total_chars += len(header)

        lang_label = "Turkish" if language == "tr" else "English"

        prompt = f"""Analyze this patient's clinical episode history and generate a comprehensive timeline summary.

{chr(10).join(sections)}

## Instructions
1. Summarize key hospitalizations with reasons and outcomes
2. Track the patient's clinical journey across outpatient visits
3. Highlight patterns: recurring conditions, escalating symptoms
4. Note any readmissions or concerning intervals
5. Group by clinical significance (most important first)
6. Reference specific dates, departments, and doctors
7. Language: {lang_label}

Generate the episode summary:"""

        summary = await self.call(prompt, temperature=0.2)
        await store_episodes_summary(protocol_id, summary)
        return summary

    async def answer_from_episodes(
        self,
        query: str,
        protocol_id: str,
        patient_context: dict[str, Any] | None = None,
        language: str = "en",
    ) -> dict[str, Any]:
        """Answer a clinical question using RAG over indexed episodes."""
        chunks = await search_episodes(protocol_id, query, limit=8)

        if not chunks:
            return {
                "analysis": "",
                "sources": [],
                "has_episodes": False,
            }

        summary = await get_episodes_summary(protocol_id)

        context_parts = []
        sources = []
        for i, chunk in enumerate(chunks, 1):
            ep_type = "Yatış" if chunk.get("is_hospitalization") else "Poliklinik"
            context_parts.append(
                f"[Episode {i}: {ep_type} — {chunk['service_text']} ({chunk['date']}) "
                f"@ {chunk['facility_text']}]\n{chunk['text'][:800]}"
            )
            sources.append({
                "episode_id": chunk["episode_id"],
                "date": chunk["date"],
                "service_text": chunk["service_text"],
                "facility_text": chunk["facility_text"],
                "is_hospitalization": chunk["is_hospitalization"],
                "output_file": chunk["output_file"],
                "score": chunk["score"],
            })

        context = "\n\n---\n\n".join(context_parts)

        patient_hint = ""
        if patient_context:
            pt = patient_context.get("patient", patient_context)
            patient_hint = f"\nPatient: {pt.get('full_name', 'Unknown')}, Age: {pt.get('age', 'N/A')}"

        summary_hint = ""
        if summary:
            summary_hint = f"\n\n## Episode Summary (cached)\n{summary[:1000]}"

        lang_label = "Turkish" if language == "tr" else "English"

        prompt = f"""Answer this clinical question using the patient's episode history.
{patient_hint}

## Question
{query}
{summary_hint}

## Relevant Episode Excerpts
{context}

## Instructions
- Answer based ONLY on information found in the episodes above
- Cite specific episode dates, departments, and doctors
- Note whether findings are from hospitalizations (yatış) or outpatient visits (poliklinik)
- If the episodes don't contain enough information, say so
- Language: {lang_label}

Answer:"""

        analysis = await self.call(prompt, temperature=0.2)

        return {
            "analysis": analysis,
            "sources": sources,
            "has_episodes": True,
        }

    async def analyze_for_council(
        self,
        message: str,
        protocol_id: str,
        fast_mode: bool = False,
        language: str = "en",
    ) -> dict[str, Any]:
        """Entry point for the orchestrator council fan-out.

        In fast mode, only do RAG search (no LLM call).
        In full mode, use the LLM to synthesize an answer from episodes.
        """
        if fast_mode:
            chunks = await search_episodes(protocol_id, message, limit=5)
            if not chunks:
                return {"analysis": "", "sources": [], "has_episodes": False}
            return {
                "analysis": "\n\n".join(
                    f"[{'Yatış' if c.get('is_hospitalization') else 'Poli'} "
                    f"{c['service_text']} ({c['date']})]: {c['text'][:300]}"
                    for c in chunks
                ),
                "sources": [
                    {
                        "episode_id": c["episode_id"],
                        "date": c["date"],
                        "service_text": c["service_text"],
                        "is_hospitalization": c["is_hospitalization"],
                        "output_file": c["output_file"],
                    }
                    for c in chunks
                ],
                "has_episodes": True,
            }

        return await self.answer_from_episodes(
            query=message,
            protocol_id=protocol_id,
            language=language,
        )
