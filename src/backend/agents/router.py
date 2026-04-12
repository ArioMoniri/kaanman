"""Router Agent — classifies incoming queries, enforces guardrails.

Uses Claude Haiku for fast classification (<500ms target).
Detects: medical vs non-medical, protocol IDs, language, urgency.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from src.backend.agents.base import BaseAgent
from src.backend.core.config import settings

_PROTOCOL_RE = re.compile(r"\b(\d{7,9})\b")
# Match protocol numbers with spaces/dashes: "7021 4897", "70 21 48 97", "7021-4897"
_PROTOCOL_SPACED_RE = re.compile(r"\b(\d{2,5}[\s\-]+(?:\d{2,5}[\s\-]+)*\d{2,5})\b")

# ── Turkish language detection (hard overrides — LLM sometimes fails) ──
# Turkish-specific characters that don't appear in other Latin-script languages
_TURKISH_CHARS_RE = re.compile(r"[çÇğĞıİöÖşŞüÜ]")
# Common Turkish medical/conversational words (case-insensitive)
_TURKISH_WORDS = [
    # Medical context
    "nesi", "nedir", "nasıl", "hastanın", "hastamızın", "hastaya",
    "hasta", "hastam", "hastamız", "hastanın",
    "durumu", "tedavi", "tanı", "ilaç", "doktor", "hekim", "hemşire",
    "muayene", "tetkik", "tahlil", "rapor", "özet", "sonuç", "bulgular",
    "şikayet", "yakınma", "ağrı", "ateş", "nabız", "tansiyon",
    "yatış", "taburcu", "ameliyat", "cerrahi", "konsültasyon",
    "izlem", "takip", "kontrol", "reçete",
    # Greetings / conversational
    "merhaba", "selam", "teşekkür", "lütfen", "evet", "hayır",
    # Common verbs / particles — high frequency in Turkish clinical queries
    "var", "yok", "ver", "göster", "anlat", "bak", "söyle",
    "bilgi", "hakkında", "için", "neden", "kaç", "hangi",
    "olan", "olarak", "olmuş", "oldu", "olsun",
    "bu", "şu", "bir", "ile", "veya", "ama", "ancak", "mi", "mı",
    "ne", "kim", "nasıl", "nerede", "kadar",
]
_TURKISH_WORDS_RE = re.compile(
    r"\b(?:" + "|".join(re.escape(w) for w in _TURKISH_WORDS) + r")\b",
    re.IGNORECASE,
)

# İzlem/monitoring keywords — force needs_izlem=true when detected
_IZLEM_KEYWORDS = [
    "izlem", "İzlem", "izlemi", "izleme", "izlemini", "izlemi nasıl",
    "izlem özet", "izlem özeti", "izlem rapor", "izlem raporu",
    "izlem brief", "izlem pdf",
    "takip", "takibi", "takip özeti",
    "vital", "vitaller", "nabız", "tansiyon",
    "spo2", "ateş", "hemşire notu", "hekim notu", "hekim izlem",
    "hemşire izlem", "ilaç takib", "ilaç izlem", "kan gazı",
    "yatış süreci", "yatış", "monitoring", "observation",
    "follow-up", "follow up",
    "generate izlem", "izlem ver", "özeti ver", "izlem oluştur",
    "günlük rapor", "daily report", "daily brief",
    "son 24 saat", "last 24 hours", "last 24h",
]
_IZLEM_RE = re.compile(
    r"(?:" + "|".join(re.escape(k) for k in _IZLEM_KEYWORDS) + r")",
    re.IGNORECASE,
)


def _detect_turkish(message: str) -> bool:
    """Detect Turkish language from message text using characters and common words."""
    if _TURKISH_CHARS_RE.search(message):
        return True
    # Need at least 2 Turkish word matches to avoid false positives
    matches = _TURKISH_WORDS_RE.findall(message)
    return len(matches) >= 2


def _detect_izlem_keywords(message: str) -> bool:
    """Detect izlem/monitoring keywords in message."""
    return bool(_IZLEM_RE.search(message))


@dataclass
class RouteDecision:
    category: str = "GENERAL"
    urgency: int = 2
    needs_clinical: bool = True
    needs_research: bool = False
    needs_drug: bool = False
    needs_izlem: bool = False
    needs_patient_context: bool = False
    guideline_countries: list[str] = field(default_factory=lambda: ["USA", "Europe"])
    reasoning: str = ""
    is_medical: bool = True
    direct_response: str = ""
    detected_protocol_id: str = ""
    language: str = "en"
    needs_decision_tree: bool = False
    priority_country: str = ""


class RouterAgent(BaseAgent):
    model = settings.models.router
    max_tokens = 512
    system_prompt = """You are a medical query router and guardrail for a doctor assistant system.

## STEP 1: GUARDRAIL — Is this a medical question?

Classify the input into one of:
- "MEDICAL" — any clinical, pharmacological, diagnostic, treatment, or health question
- "PATIENT_LOOKUP" — contains a 7-9 digit patient/protocol number (ALWAYS treat as medical)
- "GREETING" — greetings like "hello", "hi", "merhaba", "selam", small talk
- "OFF_TOPIC" — non-medical: politics, recipes, coding, math, jokes, etc.

CRITICAL RULE — PATIENT PROTOCOL NUMBERS:
If the input contains a 7-9 digit number (e.g., 70214897, 30256609), this is ALWAYS a patient
protocol number from the hospital EHR system. The doctor is asking about this patient.
- ALWAYS set is_medical=true and needs_patient_context=true
- ALWAYS set needs_clinical=true
- Common patterns (Turkish): "70214897 nesi var", "bu hastanın durumu nasıl", "bu adama ne olmuş"
- Common patterns (English): "what's wrong with 70214897", "tell me about patient 30256609"
- Even bare protocol numbers like "70214897" alone mean "show me this patient's summary"
- If the question is vague (e.g., "nesi var" = "what does he have"), classify as CLINICAL_REASONING
  — the system will fetch the patient data and the clinical agent will summarize it.

For GREETING: set is_medical=false, provide a warm direct_response in the SAME LANGUAGE as the input.
  Example (Turkish): "Merhaba! Size nasıl yardımcı olabilirim? Klinik sorularınızı bekliyorum."
  Example (English): "Hello! How can I help you? I'm ready for your clinical questions."

For OFF_TOPIC: set is_medical=false, provide a polite redirect in the SAME LANGUAGE.
  Example: "I'm a medical assistant and can only help with clinical questions. Please ask a medical question."
  Turkish: "Ben bir tıbbi asistanım ve yalnızca klinik sorulara yardımcı olabilirim. Lütfen tıbbi bir soru sorun."

For MEDICAL / PATIENT_LOOKUP: proceed to Step 2.

## STEP 2: MEDICAL CLASSIFICATION

Classify into one of:
- CLINICAL_REASONING: diagnosis, differential, interpretation of findings
- DRUG_DOSING: medication dosing, drug interactions, contraindications, prescribing
- GUIDELINE_LOOKUP: current guidelines or best practices
- LAB_INTERPRETATION: lab results analysis
- TREATMENT_PLAN: treatment planning and recommendations
- EMERGENCY: urgent/critical findings
- GENERAL: general medical questions

## STEP 3: DETECT LANGUAGE & PRIORITY COUNTRY

Detect the language and map to priority country:
- "tr" → priority_country: "Turkey"
- "en" → priority_country: "USA"
- "de" → priority_country: "Europe"
- "fr" → priority_country: "Europe"

## IZLEM (MONITORING) DATA
Set needs_izlem=true when the query involves:
- Patient monitoring notes (izlem, observation, follow-up notes)
- Vital signs tracking (vitals, nabız, tansiyon, SpO2, ateş)
- Medication administration records (ilaç izlem, drug tracking)
- Nurse/doctor observation notes (hemşire/hekim izlem)
- Blood gas monitoring (kan gazı)
- Infection control monitoring
- Any query about "what happened during hospitalization" or "yatış süreci"
- Requests for patient monitoring brief/PDF
- Turkish keywords: izlem, takip, vital, hemşire notu, hekim notu, ilaç takibi
Always set needs_izlem=true when needs_patient_context=true and the patient is hospitalized (yatış).

## STEP 4: DECISION TREE

Set needs_decision_tree=true when the query involves:
- Treatment selection with multiple pathways (e.g., "can I start drug X" → contraindication checking flow)
- Diagnostic workup with branching logic
- Algorithm-based clinical decisions
- Drug selection with dose adjustments based on conditions

## RESPOND WITH ONLY JSON:
{
  "is_medical": true,
  "category": "DRUG_DOSING",
  "urgency": 2,
  "needs_clinical": true,
  "needs_research": false,
  "needs_drug": false,
  "needs_izlem": false,
  "needs_patient_context": false,
  "needs_decision_tree": false,
  "guideline_countries": ["Turkey", "Europe", "USA"],
  "language": "tr",
  "priority_country": "Turkey",
  "direct_response": "",
  "reasoning": "brief one-line reason"
}"""

    async def classify(self, message: str, patient_context: dict[str, Any] | None = None) -> RouteDecision:
        # Pre-extract protocol ID before sending to LLM
        protocol_match = _PROTOCOL_RE.search(message)
        detected_protocol = protocol_match.group(1) if protocol_match else ""
        # Also match protocol numbers with spaces/dashes (e.g., "7021 4897" → "70214897")
        if not detected_protocol:
            spaced_match = _PROTOCOL_SPACED_RE.search(message)
            if spaced_match:
                joined = re.sub(r"[\s\-]+", "", spaced_match.group(1))
                if 7 <= len(joined) <= 9:
                    detected_protocol = joined

        ctx_hint = ""
        if patient_context:
            ctx_hint = "\n[Patient context is available for this session]"

        prompt = f"Doctor's input: {message}{ctx_hint}"

        try:
            data = await self.call_json(prompt)
            valid_fields = set(RouteDecision.__dataclass_fields__.keys())
            filtered = {k: v for k, v in data.items() if k in valid_fields}
            decision = RouteDecision(**filtered)
        except Exception:
            decision = RouteDecision(
                category="CLINICAL_REASONING",
                needs_clinical=True,
                needs_research=True,
                reasoning="Router fallback — defaulting to clinical + research",
            )

        decision.detected_protocol_id = detected_protocol

        # Hard override: if a protocol ID was detected, this is ALWAYS a patient
        # query — regardless of what the LLM classified. Doctors type protocol
        # numbers to look up patients; the LLM sometimes misclassifies these as
        # non-medical (e.g. "70214897 nesi var" → "just a number, not clinical").
        if detected_protocol:
            if not decision.is_medical:
                decision.is_medical = True
                decision.direct_response = ""
                decision.reasoning = (
                    f"Protocol ID {detected_protocol} detected — overriding to medical"
                )
            decision.needs_patient_context = True
            decision.needs_clinical = True
            if not decision.category or decision.category in ("GENERAL", "GREETING", "OFF_TOPIC"):
                decision.category = "CLINICAL_REASONING"

        # Hard override: always enable research for medical queries so that
        # structured citations/guidelines are populated in the response.
        # Without research, the KAYNAKLAR section in the answer text has
        # references but the structured citations[] array stays empty,
        # meaning impact badges never render.
        if decision.is_medical and not decision.needs_research:
            decision.needs_research = True

        # Hard override: Turkish language detection — LLM sometimes misdetects
        # Turkish as English or another language, causing wrong priority_country.
        is_turkish = _detect_turkish(message)
        if is_turkish:
            decision.language = "tr"
            decision.priority_country = "Turkey"
            if "Turkey" not in decision.guideline_countries:
                decision.guideline_countries = ["Turkey"] + [
                    c for c in decision.guideline_countries if c != "Turkey"
                ]

        # Hard override: izlem/monitoring keywords — LLM sometimes fails to set
        # needs_izlem even when the query explicitly asks for monitoring data.
        if _detect_izlem_keywords(message):
            decision.needs_izlem = True
            if not decision.reasoning or "izlem" not in decision.reasoning.lower():
                decision.reasoning = (
                    f"{decision.reasoning}; izlem keyword detected — needs_izlem forced"
                    if decision.reasoning
                    else "izlem keyword detected — needs_izlem forced"
                )

        # If we have a protocol ID and Turkish text mentioning izlem,
        # also ensure the patient context is requested
        if detected_protocol and decision.needs_izlem:
            decision.needs_patient_context = True

        return decision
