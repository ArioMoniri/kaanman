"""FastAPI route handlers for CerebraLink."""

from __future__ import annotations

import json
import traceback

from fastapi import APIRouter, HTTPException

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

router = APIRouter()
_orchestrator = Orchestrator()


@router.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    mem = SessionMemory(req.session_id)
    info = await mem.session_info()
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
