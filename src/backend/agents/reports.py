"""Reports Agent — generates patient briefs and answers questions from reports.

Uses the briefer model (high-context) for comprehensive report summarization.
Joins the orchestrator council when report data is available.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from src.backend.agents.base import BaseAgent
from src.backend.core.config import settings
from src.backend.tools.reports_rag import search_reports, get_report_brief, store_report_brief
from src.backend.tools.lab_parser import aggregate_trends

log = logging.getLogger("cerebralink.agents.reports")

# Maximum characters of report text to include in briefer prompt
_MAX_BRIEF_CHARS = 80_000


class ReportsAgent(BaseAgent):
    model = settings.models.briefer
    max_tokens = 4096
    system_prompt = """You are a clinical report summarization specialist. You analyze patient medical reports
(lab results, imaging, pathology, examinations, etc.) and provide clear, actionable summaries for doctors.

RULES:
- Focus on clinically significant findings
- Highlight abnormal lab values and trends
- Note critical or urgent findings first
- Use medical terminology appropriate for a physician audience
- Respond in the SAME LANGUAGE as the query
- Reference specific report dates when citing findings
- If lab trends show worsening values, flag them explicitly
- Group findings by clinical relevance, not just report type
"""

    async def generate_brief(
        self,
        protocol_id: str,
        manifest: list[dict],
        reports_dir: str,
        language: str = "en",
    ) -> str:
        """Generate a comprehensive patient brief from all reports.

        Reads actual report text content from TXT files, parses lab trends,
        then calls the LLM to produce a clinical brief. Caches the result in Redis.
        """
        reports_path = Path(reports_dir)

        # ── Read actual report text content ──
        report_texts: list[dict[str, str]] = []
        total_chars = 0

        for entry in manifest:
            text_file = entry.get("text_file")
            if not text_file:
                continue

            txt_path = reports_path / text_file
            if not txt_path.exists():
                continue

            try:
                with open(txt_path, "r", encoding="utf-8") as f:
                    text = f.read()
            except Exception as e:
                log.warning("Failed to read %s: %s", txt_path, e)
                continue

            if not text.strip():
                continue

            # Truncate individual reports to fit context budget
            remaining = _MAX_BRIEF_CHARS - total_chars
            if remaining <= 200:
                break
            if len(text) > remaining:
                text = text[:remaining] + "\n[... truncated due to length]"

            report_texts.append({
                "name": entry.get("report_name", ""),
                "type": entry.get("report_type", ""),
                "date": entry.get("date", ""),
                "facility": entry.get("facility", ""),
                "content": text,
            })
            total_chars += len(text)

        # ── Parse lab trends from the reports directory ──
        trends = aggregate_trends(manifest, reports_dir)
        abnormal = trends.get("_abnormal_summary", [])
        lab_count = 0
        lab_meta = trends.get("_lab_reports_parsed", [])
        if lab_meta and isinstance(lab_meta, list) and lab_meta:
            lab_count = lab_meta[0].get("count", 0)

        # ── Build report content sections ──
        report_content_parts: list[str] = []
        for rt in report_texts:
            report_content_parts.append(
                f"### {rt['name']} ({rt['type']}) — {rt['date']} — {rt['facility']}\n"
                f"{rt['content']}"
            )

        reports_without_text = len(manifest) - len(report_texts)
        no_text_note = ""
        if reports_without_text > 0:
            no_text_note = f"\n({reports_without_text} additional reports had no extractable text)"

        lang_label = "Turkish" if language == "tr" else "English"

        prompt = f"""Analyze this patient's medical reports and generate a comprehensive clinical brief.

## Report Contents ({len(report_texts)} of {len(manifest)} reports with extracted text){no_text_note}

{"---".join(report_content_parts)}

## Lab Reports Analyzed: {lab_count}

## Currently Abnormal Lab Values ({len(abnormal)} tests)
{json.dumps(abnormal, ensure_ascii=False, indent=2)}

## Instructions
1. Summarize key findings across all report types
2. Highlight critical/abnormal values with specific numbers
3. Note any concerning trends over time
4. Organize by clinical priority (most urgent first)
5. Reference specific report names and dates when citing findings
6. Language: {lang_label}

Generate the brief:"""

        brief = await self.call(prompt, temperature=0.2)

        # Cache the brief in Redis
        await store_report_brief(protocol_id, brief)

        return brief

    async def answer_from_reports(
        self,
        query: str,
        protocol_id: str,
        patient_context: dict[str, Any] | None = None,
        language: str = "en",
    ) -> dict[str, Any]:
        """Answer a clinical question using RAG over indexed reports."""
        chunks = await search_reports(protocol_id, query, limit=8)

        if not chunks:
            return {
                "analysis": "",
                "sources": [],
                "has_reports": False,
            }

        brief = await get_report_brief(protocol_id)

        context_parts = []
        sources = []
        for i, chunk in enumerate(chunks, 1):
            context_parts.append(
                f"[Report {i}: {chunk['report_name']} ({chunk['date']}) - {chunk['report_type']}]\n"
                f"{chunk['text'][:800]}"
            )
            sources.append({
                "report_name": chunk["report_name"],
                "date": chunk["date"],
                "report_type": chunk["report_type"],
                "filename": chunk["filename"],
                "pdf_file": _txt_to_original(chunk["filename"], chunk.get("original_file", "")),
                "score": chunk["score"],
            })

        context = "\n\n---\n\n".join(context_parts)

        patient_hint = ""
        if patient_context:
            pt = patient_context.get("patient", patient_context)
            patient_hint = f"\nPatient: {pt.get('full_name', 'Unknown')}, Age: {pt.get('age', 'N/A')}"

        brief_hint = ""
        if brief:
            brief_hint = f"\n\n## Patient Brief (cached)\n{brief[:1000]}"

        lang_label = "Turkish" if language == "tr" else "English"

        prompt = f"""Answer this clinical question using the patient's medical reports.
{patient_hint}

## Question
{query}
{brief_hint}

## Relevant Report Excerpts
{context}

## Instructions
- Answer based ONLY on information found in the reports above
- Cite specific report names and dates
- If the reports don't contain enough information, say so
- Language: {lang_label}

Answer:"""

        analysis = await self.call(prompt, temperature=0.2)

        return {
            "analysis": analysis,
            "sources": sources,
            "has_reports": True,
        }

    async def analyze(
        self,
        message: str,
        protocol_id: str,
        patient_context: dict[str, Any] | None = None,
        language: str = "en",
    ) -> dict[str, Any]:
        """Main entry point for the orchestrator council."""
        return await self.answer_from_reports(
            query=message,
            protocol_id=protocol_id,
            patient_context=patient_context,
            language=language,
        )

    async def analyze_for_council(
        self,
        message: str,
        protocol_id: str,
        fast_mode: bool = False,
        language: str = "en",
    ) -> dict[str, Any]:
        """Entry point for the orchestrator council fan-out.

        In fast mode, only do RAG search (no LLM call).
        In full mode, use the LLM to synthesize an answer from reports.
        """
        if fast_mode:
            # Fast mode: just return relevant chunks from RAG
            chunks = await search_reports(protocol_id, message, limit=5)
            if not chunks:
                return {"analysis": "", "sources": [], "has_reports": False}
            return {
                "analysis": "\n\n".join(
                    f"[{c['report_name']} ({c['date']})]: {c['text'][:300]}"
                    for c in chunks
                ),
                "sources": [
                    {
                        "report_name": c["report_name"],
                        "date": c["date"],
                        "filename": c["filename"],
                        "pdf_file": _txt_to_original(c["filename"], c.get("original_file", "")),
                    }
                    for c in chunks
                ],
                "has_reports": True,
            }

        # Full mode: LLM-powered analysis
        return await self.answer_from_reports(
            query=message,
            protocol_id=protocol_id,
            language=language,
        )


def _txt_to_original(txt_filename: str, original_file: str = "") -> str:
    """Map a text filename back to its original report file for deep linking.

    The scraper stores text as `{name}-txt.txt` alongside the original file
    which may be `.pdf`, `.rtf`, `.html`, or `.bin`. When the original file
    is known from chunk metadata, use it directly. Otherwise, strip the
    `-txt.txt` suffix and try `.pdf` as default.
    """
    if original_file:
        return original_file
    # Fallback: strip -txt.txt suffix and assume .pdf
    if txt_filename.endswith("-txt.txt"):
        return txt_filename[:-8] + ".pdf"
    if txt_filename.endswith(".txt"):
        return txt_filename[:-4] + ".pdf"
    return txt_filename


# Keep old name as alias for backward compat
_txt_to_pdf = _txt_to_original
