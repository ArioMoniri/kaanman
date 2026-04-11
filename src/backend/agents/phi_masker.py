"""PHI Masker Agent — strips and validates Protected Health Information.

Two modes:
  1. mask_patient_record(): full patient JSON → masked version (on ingest)
  2. check_output(): validate no PHI leaked in final response (on output)

Uses Claude Haiku for speed and consistency.
"""

from __future__ import annotations

import json
import re
from typing import Any

from src.backend.agents.base import BaseAgent
from src.backend.core.config import settings


# Regex-based pre-pass for common PHI patterns (runs before LLM)
_PATTERNS = {
    "turkish_id": re.compile(r"\b\d{11}\b"),
    "date_of_birth": re.compile(r"\b\d{2}\.\d{2}\.\d{4}\b"),
    "phone": re.compile(r"\b(?:\+90|0)\s*\d{3}\s*\d{3}\s*\d{2}\s*\d{2}\b"),
    "phone_intl": re.compile(r"\b\+?\d{1,3}[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b"),
    "email": re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b"),
    "turkish_plate": re.compile(r"\b\d{2}\s?[A-Z]{1,3}\s?\d{2,4}\b"),
}

# Protocol/patient IDs (7-9 digits) are NOT PHI — they are internal system IDs
# used by the scraper. Do NOT mask them. Also match spaced variants like "7021 4897".
_PROTOCOL_RE = re.compile(r"\b\d{7,9}\b")
_PROTOCOL_SPACED_RE = re.compile(r"\b\d{3,5}\s+\d{3,5}\b")


class PhiMasker(BaseAgent):
    model = settings.models.phi_masker
    max_tokens = 4096
    system_prompt = """You are a PHI/PII detection and masking specialist for medical records.

Your job is to identify and replace ALL Protected Health Information with consistent placeholders while preserving all medical content.

PHI includes:
- Patient names → [PATIENT_NAME]
- Parent/family names → [FAMILY_MEMBER_1], [FAMILY_MEMBER_2]
- Dates of birth → [DOB]
- Visit dates → [DATE_1], [DATE_2], etc. (keep chronological order)
- Facility names → [FACILITY_1], [FACILITY_2]
- Doctor names → [DOCTOR_1], [DOCTOR_2], etc.
- Addresses, phone numbers, emails → [REDACTED]
- 11-digit Turkish national ID numbers → [TC_ID]

DO NOT MASK:
- 7-9 digit protocol/patient IDs (e.g., 30256609, 73524705, 7021 4897) — these are internal system identifiers, even when written with spaces between digit groups
- Medical content: diagnoses, ICD codes, symptoms, medications, lab values
- Department/specialty names
- Medical terminology and clinical descriptions

PRESERVE chronological ordering of events.

Output valid JSON with:
{
  "masked_record": { ... the masked patient data ... },
  "summary": "brief clinical summary (2-3 sentences, PHI-free)",
  "phi_count": number of PHI items masked
}"""

    def _regex_prepass(self, text: str) -> str:
        """Fast regex pass to catch obvious PHI before LLM."""
        text = _PATTERNS["turkish_id"].sub("[TC_ID]", text)
        text = _PATTERNS["phone"].sub("[PHONE]", text)
        text = _PATTERNS["phone_intl"].sub("[PHONE]", text)
        text = _PATTERNS["email"].sub("[EMAIL]", text)
        return text

    async def mask_patient_record(self, patient_data: dict[str, Any]) -> dict[str, Any]:
        """Mask a full patient record (from cerebral_fetch output)."""
        raw_json = json.dumps(patient_data, ensure_ascii=False, indent=2)
        pre_masked = self._regex_prepass(raw_json)

        prompt = f"Mask all PHI in this patient record. Return ONLY valid JSON.\n\n{pre_masked}"

        try:
            result = await self.call_json(prompt)
            return result
        except Exception:
            return {
                "masked_record": json.loads(pre_masked),
                "summary": "Patient data loaded (auto-masked via regex fallback).",
                "phi_count": -1,
            }

    def check_output(self, text: str) -> str:
        """Validate that a response contains no PHI. Returns cleaned text.

        Uses REGEX ONLY — no LLM call. This preserves LaTeX, markdown, and
        all formatting exactly. The LLM-based masking is only used during
        patient record ingest, not on output responses.
        """
        for name, pattern in _PATTERNS.items():
            if name == "date_of_birth":
                # Don't mask dates in clinical context — they could be
                # guideline years, dosing schedules, etc.
                continue
            text = pattern.sub(f"[{name.upper()}]", text)
        return text
