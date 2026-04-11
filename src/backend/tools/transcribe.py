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
    log.info("Transcription result (%s): %d chars", provider, len(text))

    return {"text": text, "provider": provider}
