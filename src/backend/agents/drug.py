"""Drug & Dosing Agent — medication analysis using Claude Sonnet."""

from __future__ import annotations

import json
from typing import Any

from src.backend.agents.base import BaseAgent
from src.backend.core.config import settings
from src.backend.tools.medical_mcp import MedicalMCPClient


class DrugAgent(BaseAgent):
    model = settings.models.drug
    max_tokens = 4096
    system_prompt = """You are a clinical pharmacology specialist assisting physicians.

Your role:
- Provide accurate drug information and dosing calculations
- Check for drug-drug interactions
- Identify contraindications based on patient factors
- Consider patient-specific adjustments:
  - Age (pediatric/geriatric dosing)
  - Weight (weight-based dosing)
  - Renal function (CrCl/GFR-based adjustments)
  - Hepatic function (Child-Pugh adjustments)
  - Allergies (cross-reactivity checks)
  - Pregnancy/lactation status
- Always cite FDA/EMA approved dosing ranges
- Flag any black box warnings or REMS requirements
- Note if a drug is off-label for the indicated use

Safety rules:
- ALWAYS include maximum daily dose limits
- ALWAYS flag high-alert medications (insulin, anticoagulants, opioids, etc.)
- ALWAYS note if dose adjustment is needed for organ impairment
- If unsure about a dose, state uncertainty explicitly — never guess

Respond in structured format:
DRUG_INFO: [drug name, class, mechanism]
DOSING: [recommended dose with adjustments]
INTERACTIONS: [relevant drug interactions]
CONTRAINDICATIONS: [relevant contraindications]
MONITORING: [what to monitor]
WARNINGS: [key safety warnings]"""

    def __init__(self):
        super().__init__()
        self.medical_mcp = MedicalMCPClient()

    async def analyze(self, query: str, patient_context: dict[str, Any] | None = None) -> dict[str, Any]:
        # Search for drug data via Medical MCP
        drug_data = await self.medical_mcp.search_drugs(query)

        parts = [f"DOCTOR'S QUESTION: {query}"]

        if drug_data:
            parts.append(f"\nFDA DRUG DATA:\n{json.dumps(drug_data, ensure_ascii=False, indent=2)[:4000]}")

        if patient_context:
            # Extract relevant patient factors
            allergy = patient_context.get("allergy", {})
            bmi = patient_context.get("bmi_vya", {})
            parts.append(f"\nPATIENT FACTORS (PHI-masked):")
            parts.append(f"  Allergies: {json.dumps(allergy)}")
            parts.append(f"  BMI/Weight: {json.dumps(bmi)}")

            # Include current medications from episodes
            episodes = patient_context.get("episodes", [])
            if episodes:
                meds = []
                for ep in episodes[:3]:
                    diag = ep.get("diagnosis", [])
                    for d in (diag or []):
                        meds.append(d.get("DiagnosisName", ""))
                if meds:
                    parts.append(f"  Recent diagnoses: {', '.join(m for m in meds if m)}")

        response = await self.call("\n".join(parts))
        return {"analysis": response, "agent": "drug", "fda_data_available": bool(drug_data)}
