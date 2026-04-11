"""FastAPI route handlers for CerebraLink."""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import StreamingResponse

from src.backend.api.schemas import (
    ChatRequest,
    ChatResponse,
    PatientIngestRequest,
    PatientIngestResponse,
    SessionInfoResponse,
)
from src.backend.core.memory import SessionMemory
from src.backend.core.orchestrator import Orchestrator
from src.backend.agents.phi_masker import PhiMasker
from src.backend.tools.cerebral import ingest_cookies_json
from src.backend.tools.transcribe import transcribe_audio, get_transcription_provider

router = APIRouter()
_orchestrator = Orchestrator()


@router.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    mem = SessionMemory(req.session_id)
    await mem.session_info()
    session_id = mem.session_id

    await mem.append_message("user", req.message)
    patient_ctx = await mem.get_patient_context()
    history = await mem.get_history(last_n=10)

    result = await _orchestrator.run(
        message=req.message,
        patient_context=patient_ctx,
        history=history,
        session_id=session_id,
    )

    await mem.append_message("assistant", result.fast_answer, {
        "complete_answer": result.complete_answer,
        "trust_scores": result.trust_scores.model_dump(),
    })

    return ChatResponse(session_id=session_id, **result.model_dump())


@router.post("/api/chat/stream")
async def chat_stream(req: ChatRequest):
    """SSE streaming endpoint — sends agent status, fast answer, then full result."""
    mem = SessionMemory(req.session_id)
    await mem.session_info()
    session_id = mem.session_id

    await mem.append_message("user", req.message)
    patient_ctx = await mem.get_patient_context()
    history = await mem.get_history(last_n=10)

    status_queue: asyncio.Queue[dict | None] = asyncio.Queue()

    async def on_status(event: dict):
        await status_queue.put(event)

    async def run_orchestrator():
        try:
            result = await _orchestrator.run(
                message=req.message,
                patient_context=patient_ctx,
                history=history,
                session_id=session_id,
                on_status=on_status,
            )
            await mem.append_message("assistant", result.fast_answer, {
                "complete_answer": result.complete_answer,
                "trust_scores": result.trust_scores.model_dump(),
            })
            resp = ChatResponse(session_id=session_id, **result.model_dump())
            await status_queue.put({"_type": "result", "data": resp.model_dump()})
        except Exception as e:
            await status_queue.put({"_type": "error", "message": str(e)})
        finally:
            await status_queue.put(None)

    async def event_generator():
        task = asyncio.create_task(run_orchestrator())
        try:
            while True:
                event = await status_queue.get()
                if event is None:
                    break
                event_type = event.pop("_type", "status")
                if event_type == "result":
                    yield f"event: result\ndata: {json.dumps(event['data'])}\n\n"
                elif event_type == "error":
                    yield f"event: error\ndata: {json.dumps({'message': event['message']})}\n\n"
                elif event_type == "fast_answer":
                    yield f"event: fast_answer\ndata: {json.dumps(event)}\n\n"
                else:
                    yield f"event: status\ndata: {json.dumps(event)}\n\n"
            yield f"event: done\ndata: {{}}\n\n"
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/api/patient/ingest", response_model=PatientIngestResponse)
async def ingest_patient(req: PatientIngestRequest):
    mem = SessionMemory()
    try:
        patient_data = await ingest_cookies_json(req.cookies_json)
    except Exception as e:
        return PatientIngestResponse(
            success=False, session_id=mem.session_id,
            error=f"Failed to fetch patient data: {e}",
        )

    masker = PhiMasker()
    masked = await masker.mask_patient_record(patient_data)

    await mem.set_patient_context(masked["masked_record"])
    summary = masked.get("summary", "Patient data loaded (PHI masked).")

    return PatientIngestResponse(
        success=True, session_id=mem.session_id, patient_summary=summary,
    )


@router.post("/api/patient/clear")
async def clear_patient(session_id: str | None = None):
    if not session_id:
        raise HTTPException(400, "session_id required")
    mem = SessionMemory(session_id)
    await mem.clear_patient_context()
    return {"success": True}


@router.get("/api/session/{session_id}", response_model=SessionInfoResponse)
async def session_info(session_id: str):
    mem = SessionMemory(session_id)
    info = await mem.session_info()
    patient_ctx = await mem.get_patient_context()
    summary = None
    if patient_ctx:
        summary = patient_ctx.get("summary", "Patient data loaded.")
    return SessionInfoResponse(**info, patient_summary=summary)


# ── Speech-to-text transcription ──

@router.get("/api/transcribe/check")
async def transcribe_check():
    """Check if server-side transcription is available."""
    provider = get_transcription_provider()
    return {"available": provider is not None, "provider": provider}


@router.post("/api/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str | None = Form(None),
):
    """Transcribe an audio file using Groq or OpenAI Whisper.

    Accepts audio uploads (webm, ogg, mp3, wav, m4a).
    Returns {"text": "...", "provider": "groq"|"openai"}.
    """
    provider = get_transcription_provider()
    if not provider:
        raise HTTPException(
            503,
            "No transcription API configured. Set GROQ_API_KEY or OPENAI_API_KEY.",
        )

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(400, "Empty audio file")

    # Sanity check: reject files > 25MB (Whisper API limit)
    if len(audio_bytes) > 25 * 1024 * 1024:
        raise HTTPException(413, "Audio file too large (max 25MB)")

    try:
        result = await transcribe_audio(
            audio_bytes=audio_bytes,
            filename=file.filename or "audio.webm",
            language=language,
        )
        return result
    except RuntimeError as e:
        raise HTTPException(502, str(e))
