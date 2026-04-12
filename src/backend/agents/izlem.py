"""Izlem (Follow-up Monitoring) Agent -- analyzes patient monitoring data and generates PDF briefs.

Joins the orchestrator council when izlem data is available.
Provides clinical context from doctor/nurse notes, vitals, medications, labs.
Can generate PDF briefs with last-24h emphasis.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from typing import Any

from src.backend.agents.base import BaseAgent
from src.backend.core.config import settings

log = logging.getLogger("cerebralink.agents.izlem")

_MAX_IZLEM_CHARS = 60_000

# Izlem data categories ordered by clinical priority
_KEY_CATEGORIES = [
    "hekim_izlem_notlari",
    "vital_bulgular",
    "ilac_izlem",
    "laboratuvar_izlem",
    "kangazi_izlem",
    "hemsire_izlem_notlari",
]

_ALL_CATEGORIES = _KEY_CATEGORIES + [
    "enfeksiyon_kontrol_izlem",
    "basinc_yarasi_izlem",
    "norolojik_izlem",
    "diyabet_izlem",
    "ventilasyon_izlem",
    "nutrisyon_izlem",
    "rehabilitasyon_izlem",
    "agri_izlem",
    "yara_bakimi_izlem",
]


def _parse_date(date_str: str) -> datetime | None:
    """Try common Turkish date formats."""
    for fmt in ("%d.%m.%Y %H:%M", "%d.%m.%Y", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(date_str.strip(), fmt)
        except (ValueError, AttributeError):
            continue
    return None


def _extract_episodes(izlem_data: dict, max_episodes: int = 3) -> list[dict]:
    """Return the most recent N episodes from izlem data."""
    episodes = izlem_data.get("episodes", [])
    if not episodes:
        return []
    # Sort by date descending (most recent first)
    def _sort_key(ep: dict) -> str:
        return ep.get("episode_info", {}).get("date", "0")
    episodes_sorted = sorted(episodes, key=_sort_key, reverse=True)
    return episodes_sorted[:max_episodes]


def _format_category_data(category: str, rows: list[dict], max_rows: int = 15) -> str:
    """Format a category's rows into readable text."""
    if not rows:
        return ""
    lines = [f"### {category} ({len(rows)} records)"]
    for row in rows[:max_rows]:
        parts = []
        for key, val in row.items():
            if val and str(val).strip():
                parts.append(f"{key}: {val}")
        if parts:
            lines.append("  - " + " | ".join(parts))
    if len(rows) > max_rows:
        lines.append(f"  ... ({len(rows) - max_rows} more rows)")
    return "\n".join(lines)


def _build_episode_context(episode: dict, max_chars: int = 15_000) -> str:
    """Build a text context block from a single izlem episode."""
    ep_info = episode.get("episode_info", {})
    header = (
        f"## Episode: {ep_info.get('date', 'Unknown date')} "
        f"-- {ep_info.get('serviceText', '')} "
        f"@ {ep_info.get('facilityText', '')}"
    )
    sections = [header]
    total = len(header)
    data = episode.get("data", {})

    # Process key categories first, then remaining
    processed = set()
    for cat in _KEY_CATEGORIES:
        if cat in data and data[cat]:
            text = _format_category_data(cat, data[cat])
            if text and total + len(text) < max_chars:
                sections.append(text)
                total += len(text)
                processed.add(cat)

    # Remaining categories
    for cat, rows in data.items():
        if cat in processed or not rows:
            continue
        text = _format_category_data(cat, rows, max_rows=8)
        if text and total + len(text) < max_chars:
            sections.append(text)
            total += len(text)

    return "\n\n".join(sections)


class IzlemAgent(BaseAgent):
    model = settings.models.briefer
    max_tokens = 4096
    system_prompt = """You are a clinical monitoring data specialist (izlem analisti). You analyze
patient follow-up monitoring data from hospital EHR systems, including:
- Doctor observation notes (hekim izlem notlari)
- Nurse observation notes (hemsire izlem notlari)
- Vital signs (vital bulgular): pulse, blood pressure, SpO2, temperature
- Blood gas monitoring (kan gazi izlem)
- Medication tracking (ilac izlem)
- Laboratory results (laboratuvar izlem)
- Infection control, pressure sore tracking, neurological, diabetes, ventilation monitoring

RULES:
- Emphasize the LAST 24 HOURS of data — flag any acute changes
- Identify abnormal vitals: HR>120 or <50, SpO2<92%, Temp>38.5C, MAP<65
- Track medication changes and new prescriptions
- Note infection control findings and antibiotic escalation/de-escalation
- Highlight lab trends (rising WBC, declining Hb, electrolyte shifts)
- Cross-reference doctor and nurse notes for clinical consistency
- Group findings by clinical significance (most critical first)
- Respond in the SAME LANGUAGE as the query
- Reference specific dates, times, and values when citing findings
"""

    async def analyze_for_council(
        self,
        message: str,
        protocol_id: str,
        izlem_data: dict | None = None,
        fast_mode: bool = False,
        language: str = "en",
    ) -> dict[str, Any]:
        """Entry point for the orchestrator council fan-out.

        In fast mode, only do RAG search (no LLM call).
        In full mode, build context from izlem data and call LLM for synthesis.
        """
        if fast_mode:
            try:
                from src.backend.tools.izlem_rag import search_izlem
            except ImportError:
                log.warning("izlem_rag module not available; falling back to full mode")
                fast_mode = False

            if fast_mode:
                chunks = await search_izlem(protocol_id, message, limit=5)
                if not chunks:
                    return {"analysis": "", "sources": [], "has_izlem": False}
                return {
                    "analysis": "\n\n".join(
                        f"[{c.get('category', 'izlem')} "
                        f"({c.get('date', '')})]: {c.get('text', '')[:400]}"
                        for c in chunks
                    ),
                    "sources": [
                        {
                            "episode_id": c.get("episode_id", ""),
                            "date": c.get("date", ""),
                            "category": c.get("category", ""),
                            "score": c.get("score", 0),
                        }
                        for c in chunks
                    ],
                    "has_izlem": True,
                }

        # Full mode: build context from izlem_data and call LLM
        if not izlem_data:
            return {"analysis": "", "sources": [], "has_izlem": False}

        recent_episodes = _extract_episodes(izlem_data, max_episodes=3)
        if not recent_episodes:
            return {"analysis": "", "sources": [], "has_izlem": False}

        # Build context from the most recent episodes
        context_parts: list[str] = []
        total_chars = 0
        sources: list[dict] = []
        for ep in recent_episodes:
            ep_info = ep.get("episode_info", {})
            remaining = _MAX_IZLEM_CHARS - total_chars
            if remaining <= 200:
                break
            ctx = _build_episode_context(ep, max_chars=min(remaining, 20_000))
            context_parts.append(ctx)
            total_chars += len(ctx)
            sources.append({
                "episode_id": str(ep_info.get("episodeId", "")),
                "date": ep_info.get("date", ""),
                "service_text": ep_info.get("serviceText", ""),
                "facility_text": ep_info.get("facilityText", ""),
            })

        context = "\n\n---\n\n".join(context_parts)
        lang_label = "Turkish" if language == "tr" else "English"

        prompt = f"""Analyze this patient's izlem (follow-up monitoring) data to answer the clinical question.

## Question
{message}

## Izlem Data (most recent {len(recent_episodes)} episodes)
{context}

## Instructions
- Focus on the LAST 24 HOURS of monitoring data
- Flag any abnormal vitals, lab values, or medication changes
- Cross-reference doctor notes with nurse observations
- Note trends (improving, worsening, stable)
- Cite specific dates, times, and values
- Language: {lang_label}

Answer:"""

        analysis = await self.call(prompt, temperature=0.2)

        return {
            "analysis": analysis,
            "sources": sources,
            "has_izlem": True,
        }

    async def generate_brief(
        self,
        protocol_id: str,
        izlem_data: dict,
        language: str = "en",
    ) -> str:
        """Generate a structured text brief of the patient's monitoring data.

        Focuses on the last 3 episodes with emphasis on the last 24 hours.
        Returns the LLM-generated brief text.
        """
        recent_episodes = _extract_episodes(izlem_data, max_episodes=3)
        if not recent_episodes:
            return "No izlem episodes available for briefing."

        # Build detailed context for the brief
        context_parts: list[str] = []
        for i, ep in enumerate(recent_episodes):
            label = "MOST RECENT" if i == 0 else f"Episode {i + 1}"
            ctx = _build_episode_context(ep, max_chars=20_000)
            context_parts.append(f"# {label}\n{ctx}")

        context = "\n\n===\n\n".join(context_parts)
        lang_label = "Turkish" if language == "tr" else "English"

        prompt = f"""Generate a structured clinical monitoring brief for patient protocol {protocol_id}.
This brief is a DAILY IZLEM REPORT for doctors to quickly understand what happened in the last 24 hours
and important context from the patient's recent history.

{context}

## Brief Structure (follow this EXACTLY):

### SON 24 SAAT ÖZETİ / LAST 24 HOURS SUMMARY
- Key clinical changes and acute findings in the last 24 hours
- Vital signs trends with specific values (pulse, BP, SpO2, temp)
- What the hekim (doctor) did: examinations, orders, medication changes
- What the hemşire (nurse) observed: patient status, interventions, responses
- Any critical findings or alerts
- Lab results from the last 24h if available

### GÜNCEL İLAÇLAR / CURRENT MEDICATIONS
- List all active medications with doses and routes
- Highlight any recent changes (new, stopped, dose adjusted) in the last 24h

### EPİZOD 1 (En Son) / EPISODE 1 (Most Recent)
- Date, service, facility
- Doctor notes summary
- Key vital signs
- Lab results
- Medications administered

### EPİZOD 2 / EPISODE 2
- Key findings and notable changes

### EPİZOD 3 / EPISODE 3
- Key findings and notable changes

### DİKKAT GEREKTİREN GEÇMİŞ OLAYLAR / PAST EVENTS REQUIRING ATTENTION
- Previous falls (düşme) or fall risk
- Known allergies (alerjiler)
- Infection history (MRSA, VRE, izolasyon)
- Pressure sores (basınç yarası, dekübit)
- Bleeding events (kanama)
- Intubation/ventilation history
- Any recurring clinical issue from previous izlems that needs continued attention

### UYARILAR VE ALERTLER / ALERTS
- Abnormal vitals (HR>120 or <50, SpO2<92%, Temp>38.5°C, MAP<65)
- Significant lab changes or critical values
- Infection control concerns
- Medication interactions or escalation

Language: {lang_label}
Generate the brief:"""

        brief = await self.call(prompt, temperature=0.2)
        return brief

    async def generate_pdf_brief(
        self,
        protocol_id: str,
        izlem_data: dict,
        language: str = "en",
    ) -> str:
        """Generate a PDF brief of the patient's monitoring data.

        Delegates to izlem_pdf.py for actual PDF creation.
        Returns the path to the generated PDF file.
        """
        # First generate the structured text brief via LLM
        brief_text = await self.generate_brief(protocol_id, izlem_data, language)

        # Then create the PDF
        from src.backend.tools.izlem_pdf import create_izlem_pdf

        pdf_path = await create_izlem_pdf(
            protocol_id=protocol_id,
            brief_text=brief_text,
            izlem_data=izlem_data,
            language=language,
        )

        log.info("Generated izlem PDF brief for %s: %s", protocol_id, pdf_path)
        return pdf_path
