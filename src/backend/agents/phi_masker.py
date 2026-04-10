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
    "patient_id": re.compile(r"\b3025\s*6609\b"),
    "date_of_birth": re.compile(r"\b\d{2}\.\d{2}\.\d{4}\b"),
    "phone": re.compile(r"\b(?:\+90|0)\s*\d{3}\s*\d{3}\s*\d{2}\s*\d{2}\b"),
    "email": re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b"),
}


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
- Patient IDs/MRNs → [PATIENT_ID]
- Facility names → [FACILITY_1], [FACILITY_2]
- Doctor names → [DOCTOR_1], [DOCTOR_2], etc.
- Addresses, phone numbers, emails → [REDACTED]
- Any other identifying information → [REDACTED]

PRESERVE:
- All medical content: diagnoses, ICD codes, symptoms, medications, lab values
- Medical terminology and clinical descriptions
- Chronological ordering of events (use relative timing: "Visit 1", "Visit 2")
- Department/specialty names (these are not PHI)

Output valid JSON with:
{
  "masked_record": { ... the masked patient data ... },
  "summary": "brief clinical summary (2-3 sentences, PHI-free)",
  "phi_count": number of PHI items masked
}"""

    def _regex_prepass(self, text: str) -> str:
        """Fast regex pass to catch obvious PHI before LLM."""
        text = _PATTERNS["patient_id"].sub("[PATIENT_ID]", text)
        text = _PATTERNS["phone"].sub("[PHONE]", text)
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
            # Fallback: return regex-masked version
            return {
                "masked_record": json.loads(pre_masked),
                "summary": "Patient data loaded (auto-masked via regex fallback).",
                "phi_count": -1,
            }

    async def check_output(self, text: str) -> str:
        """Validate that a response contains no PHI. Returns cleaned text."""
        # Fast regex check first
        has_phi = False
        for name, pattern in _PATTERNS.items():
            if pattern.search(text):
                has_phi = True
                break

        if not has_phi and len(text) < 100:
            return text

        prompt = f"""Check this medical response for any PHI/PII leakage.
If you find any PHI, replace it with appropriate placeholders.
If the text is clean, return it unchanged.

Return ONLY the cleaned text, nothing else.

---
{text}
---"""

        return await self.call(prompt, temperature=0.0)
