"""Prescription Writer Agent — country-specific prescription formatting."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from src.backend.agents.base import BaseAgent
from src.backend.core.config import settings

log = logging.getLogger("cerebralink.prescription")

# ---------------------------------------------------------------------------
# Turkish drug database (ilac.json) — loaded once at module level
# ---------------------------------------------------------------------------
_ILAC_DB: dict[str, list[dict]] = {}  # active_ingredient (lower) -> list of products
_ILAC_LOADED = False


def _load_ilac_db() -> None:
    global _ILAC_DB, _ILAC_LOADED
    if _ILAC_LOADED:
        return
    ilac_path = Path(__file__).resolve().parents[3] / "ilac.json"
    if not ilac_path.exists():
        log.warning("ilac.json not found at %s", ilac_path)
        _ILAC_LOADED = True
        return
    try:
        raw = json.loads(ilac_path.read_text(encoding="utf-8"))
        records: list[dict] = []
        for item in raw:
            if isinstance(item, dict) and item.get("type") == "table":
                records = item.get("data", [])
                break
        for rec in records:
            ingredient = (rec.get("Active_Ingredient") or "").strip().lower()
            if ingredient:
                _ILAC_DB.setdefault(ingredient, []).append({
                    "product_name": rec.get("Product_Name", ""),
                    "atc_code": rec.get("ATC_code", ""),
                    "barcode": rec.get("barcode", ""),
                    "category": rec.get("Category_1", "").strip(),
                })
        log.info(
            "Loaded %d drugs (%d ingredients) from ilac.json",
            len(records),
            len(_ILAC_DB),
        )
    except Exception as e:
        log.error("Failed to load ilac.json: %s", e)
    _ILAC_LOADED = True


def search_turkish_brands(active_ingredient: str) -> list[dict]:
    """Find all Turkish brand names for an active ingredient."""
    _load_ilac_db()
    key = active_ingredient.strip().lower()
    # Exact match first
    if key in _ILAC_DB:
        return _ILAC_DB[key]
    # Partial match fallback
    matches: list[dict] = []
    for k, v in _ILAC_DB.items():
        if key in k or k in key:
            matches.extend(v)
    return matches[:20]  # Limit results


# ---------------------------------------------------------------------------
# PrescriptionAgent
# ---------------------------------------------------------------------------

class PrescriptionAgent(BaseAgent):
    model = settings.models.drug  # Same model tier as drug agent
    max_tokens = 4096
    system_prompt = """You are a prescription writing specialist for clinical settings.

Your role:
- Write formal, country-specific prescriptions based on clinical recommendations
- Use the EXACT brand/business names available in that country
- Include proper dosing, quantity, usage instructions
- When multiple brand options exist for a drug, present them as numbered choices
- Include drug calculations if weight-based or renal-adjusted dosing is needed
- Format output as a clean, copyable prescription

## PRESCRIPTION FORMAT BY COUNTRY

### Turkey (Turkiye):
```
RECETE
Tarih: [DD.MM.YYYY]

Rx:
1. [URUN ADI] ([Etkin Madde])
   Doz: [miktar ve siklik]
   Kullanim: [kullanim sekli]
   Adet: [kutu sayisi]

2. [URUN ADI] ([Etkin Madde])
   ...

Uyarilar:
- [ilgili uyarilar]

Not: [ek bilgiler]
```

### International / English:
```
PRESCRIPTION
Date: [YYYY-MM-DD]

Rx:
1. [Product Name] ([Active Ingredient])
   Dose: [amount and frequency]
   Route: [oral/IV/etc.]
   Quantity: [number]

Warnings:
- [relevant warnings]
```

## RULES:
- ALWAYS use real brand names from the country's market
- When given Turkish drug database results, use those exact Product_Name values
- If multiple brands available, show as: "Choose one: 1) BRAND_A  2) BRAND_B  3) BRAND_C"
- Include ATC code if available
- For controlled substances, add appropriate warnings
- Calculate quantities based on treatment duration
- If dose needs calculation (weight-based etc.), show the math
- Output must be clean text that can be directly copied as a prescription
- Respond in the language matching the country (Turkish for Turkey, etc.)"""

    async def write_prescription(
        self,
        query: str,
        drug_recommendations: str,
        patient_context: dict[str, Any] | None = None,
        priority_country: str | None = None,
    ) -> dict[str, Any]:
        """Generate a formatted prescription based on drug recommendations."""

        parts = [f"CLINICAL REQUEST: {query}"]
        parts.append(f"\nDRUG RECOMMENDATIONS:\n{drug_recommendations}")

        country = priority_country or "Turkey"
        parts.append(f"\nCOUNTRY: {country}")

        # For Turkey, search the local drug database for brand names
        brand_info: list[dict] = []
        if country.lower() in ("turkey", "türkiye", "tr"):
            # Extract potential drug ingredient names from recommendations
            potential_drugs: set[str] = set()
            for word in re.findall(
                r"\b[A-Za-z\u00e7\u011f\u0131\u00f6\u015f\u00fc"
                r"\u00c7\u011e\u0130\u00d6\u015e\u00dc]{4,}\b",
                drug_recommendations,
            ):
                brands = search_turkish_brands(word)
                if brands:
                    lw = word.lower()
                    if lw not in potential_drugs:
                        potential_drugs.add(lw)
                        brand_info.append({
                            "ingredient": word,
                            "brands": [b["product_name"] for b in brands[:10]],
                            "atc": brands[0].get("atc_code", ""),
                        })

            if brand_info:
                parts.append("\nTURKISH DRUG DATABASE RESULTS:")
                for info in brand_info:
                    parts.append(
                        f"\n  Active Ingredient: {info['ingredient']}"
                        f" (ATC: {info['atc']})"
                    )
                    parts.append("  Available brands in Turkey:")
                    for i, brand in enumerate(info["brands"], 1):
                        parts.append(f"    {i}. {brand}")
                parts.append(
                    "\nUse these EXACT brand names in the prescription."
                )

        if patient_context:
            allergy = patient_context.get("allergy", {})
            bmi = patient_context.get("bmi_vya", {})
            parts.append("\nPATIENT CONTEXT:")
            if allergy:
                parts.append(
                    f"  Allergies: {json.dumps(allergy, ensure_ascii=False)}"
                )
            if bmi:
                parts.append(
                    f"  BMI/Weight: {json.dumps(bmi, ensure_ascii=False)}"
                )

        response = await self.call("\n".join(parts))

        return {
            "prescription": response,
            "agent": "prescription",
            "brand_options": brand_info,
            "country": country,
        }
