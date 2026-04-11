"""Speech-to-text transcription via Groq or OpenAI Whisper API.

Uses httpx (already a dependency) — no additional packages needed.
Groq is preferred (free tier: 14,400 req/day, ~25x real-time speed).
Falls back to OpenAI Whisper if OPENAI_API_KEY is set but not GROQ_API_KEY.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from src.backend.core.config import settings

log = logging.getLogger("cerebralink.transcribe")

# Both Groq and OpenAI use the same OpenAI-compatible endpoint format
_GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
_OPENAI_URL = "https://api.openai.com/v1/audio/transcriptions"


def get_transcription_provider() -> str | None:
    """Return which provider is configured, or None."""
    if settings.groq_api_key:
        return "groq"
    if settings.openai_api_key:
        return "openai"
    return None


async def transcribe_audio(
    audio_bytes: bytes,
    filename: str = "audio.webm",
    language: str | None = None,
) -> dict[str, Any]:
    """Transcribe audio bytes using Groq or OpenAI Whisper API.

    Args:
        audio_bytes: Raw audio file bytes (webm, ogg, mp3, wav, etc.)
        filename: Original filename (used for content-type detection)
        language: Optional ISO-639-1 language code (e.g. "tr", "en")

    Returns:
        {"text": "transcribed text", "provider": "groq"|"openai"}

    Raises:
        RuntimeError: If no API key is configured or API call fails.
    """
    if settings.groq_api_key:
        api_key = settings.groq_api_key
        url = _GROQ_URL
        model = "whisper-large-v3-turbo"
        provider = "groq"
    elif settings.openai_api_key:
        api_key = settings.openai_api_key
        url = _OPENAI_URL
        model = "whisper-1"
        provider = "openai"
    else:
        raise RuntimeError(
            "No transcription API key configured. "
            "Set GROQ_API_KEY (free) or OPENAI_API_KEY in your .env file."
        )

    # Content type mapping
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "webm"
    content_types = {
        "webm": "audio/webm",
        "ogg": "audio/ogg",
        "mp3": "audio/mpeg",
        "wav": "audio/wav",
        "m4a": "audio/mp4",
        "mp4": "audio/mp4",
        "flac": "audio/flac",
    }
    content_type = content_types.get(ext, "audio/webm")

    # Build multipart form data
    form_data = {
        "model": model,
        "response_format": "json",
    }
    if language:
        form_data["language"] = language

    files = {"file": (filename, audio_bytes, content_type)}

    log.info("Transcribing %dB audio via %s (%s)", len(audio_bytes), provider, model)

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            url,
            headers={"Authorization": f"Bearer {api_key}"},
            data=form_data,
            files=files,
        )

    if resp.status_code != 200:
        error_detail = resp.text[:500]
        log.error("Transcription failed: HTTP %d — %s", resp.status_code, error_detail)
        raise RuntimeError(f"Transcription API returned HTTP {resp.status_code}: {error_detail}")

    result = resp.json()
    text = result.get("text", "").strip()
    text = _normalize_spoken_numbers(text)
    log.info("Transcription result (%s): %d chars", provider, len(text))

    return {"text": text, "provider": provider}


# ── Spoken number normalization (Turkish + English) ──

_TR_NUMBERS: dict[str, str] = {
    "sıfır": "0", "bir": "1", "iki": "2", "üç": "3", "dört": "4",
    "beş": "5", "altı": "6", "yedi": "7", "sekiz": "8", "dokuz": "9",
    "on": "10", "yirmi": "20", "otuz": "30", "kırk": "40", "elli": "50",
    "altmış": "60", "yetmiş": "70", "seksen": "80", "doksan": "90",
    "yüz": "100",
}

_EN_NUMBERS: dict[str, str] = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4",
    "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
    "ten": "10", "eleven": "11", "twelve": "12", "thirteen": "13",
    "fourteen": "14", "fifteen": "15", "sixteen": "16", "seventeen": "17",
    "eighteen": "18", "nineteen": "19", "twenty": "20", "thirty": "30",
    "forty": "40", "fifty": "50", "sixty": "60", "seventy": "70",
    "eighty": "80", "ninety": "90", "hundred": "100",
}


def _normalize_spoken_numbers(text: str) -> str:
    """Convert spoken digit sequences to numeric form.

    Handles Turkish (yetmiş iki → 72) and English (seventy two → 72).
    Collapses space-separated digit groups into single numbers:
      "70 21 48 97" → "70214897"
    """
    import re

    all_numbers = {**_TR_NUMBERS, **_EN_NUMBERS}
    words = text.split()
    result: list[str] = []
    num_buffer: list[int] = []

    def flush_buffer():
        if num_buffer:
            # Combine: [70, 2] → 72; [70, 21, 48, 97] → "70214897"
            # Heuristic: if numbers are tens+units pairs, combine arithmetically
            # Otherwise concatenate as strings (protocol IDs)
            combined = ""
            i = 0
            while i < len(num_buffer):
                n = num_buffer[i]
                # tens + single digit → add (e.g., 70 + 2 = 72)
                if n >= 10 and n % 10 == 0 and n < 100 and i + 1 < len(num_buffer) and num_buffer[i + 1] < 10:
                    combined += str(n + num_buffer[i + 1])
                    i += 2
                else:
                    combined += str(n)
                    i += 1
            result.append(combined)
            num_buffer.clear()

    for word in words:
        clean = word.strip(".,;:!?").lower()
        if clean in all_numbers:
            num_buffer.append(int(all_numbers[clean]))
        else:
            flush_buffer()
            result.append(word)

    flush_buffer()

    out = " ".join(result)
    # Also collapse digit groups separated by single spaces or dashes
    out = re.sub(r"(\d)\s*[-–—]\s*(\d)", r"\1\2", out)
    return out
