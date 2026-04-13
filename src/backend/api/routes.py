"""FastAPI route handlers for CerebraLink."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from src.backend.api.schemas import (
    ChatRequest,
    ChatResponse,
    PatientIngestRequest,
    PatientIngestResponse,
    SessionInfoResponse,
)
from src.backend.core.memory import SessionMemory, set_global_patient_cache
from src.backend.core.orchestrator import Orchestrator
from src.backend.agents.phi_masker import PhiMasker
from src.backend.tools.cerebral import ingest_cookies_json
from src.backend.tools.transcribe import transcribe_audio, get_transcription_provider
from src.backend.tools.reports import (
    auto_fetch_reports,
    get_manifest,
    get_manifest_with_pacs,
    get_reports_dir,
    reports_exist,
    get_fresh_pacs_link,
    get_pacs_links,
    refresh_all_pacs_links,
)
from src.backend.tools.reports_rag import (
    index_reports,
    search_reports as rag_search_reports,
    get_report_brief,
)
from src.backend.tools.lab_parser import aggregate_trends
from src.backend.tools.episodes import (
    auto_fetch_episodes,
    episodes_exist,
    get_manifest as get_episodes_manifest,
    get_episodes_dir,
    get_yatis_summary,
    get_full_manifest_data as get_full_episodes_manifest,
    cross_match_reports,
)
from src.backend.tools.episodes_rag import (
    index_episodes,
    search_episodes as rag_search_episodes,
    get_episodes_summary,
)
from src.backend.tools.graph import (
    neo4j_available,
    ingest_patient_history,
    ingest_reports,
    ingest_episodes as graph_ingest_episodes,
    query_patient_graph,
    query_reports_graph,
    query_episodes_graph,
    query_full_graph,
)
from src.backend.agents.reports import ReportsAgent
from src.backend.agents.episodes import EpisodesAgent
from src.backend.tools.izlem import (
    auto_fetch_izlem,
    izlem_exists,
    get_izlem_data,
    get_izlem_dir,
)
from src.backend.tools.izlem_rag import (
    index_izlem,
    search_izlem as rag_search_izlem,
)
from src.backend.agents.izlem import IzlemAgent

router = APIRouter()
_orchestrator = Orchestrator()
_reports_agent = ReportsAgent()
_episodes_agent = EpisodesAgent()
_izlem_agent = IzlemAgent()


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
        "trust_reasons": result.trust_reasons.model_dump() if hasattr(result.trust_reasons, "model_dump") else {},
        "scorer_confidence": result.scorer_confidence,
        "citations": [c.model_dump() for c in result.citations],
        "guidelines_used": [g.model_dump() for g in result.guidelines_used],
        "agents_used": result.agents_used,
        "total_time_ms": result.total_time_ms,
        "language": result.language,
        "priority_country": result.priority_country,
        "izlem_brief_pdf": result.izlem_brief_pdf,
        "prescription_data": result.prescription_data.model_dump() if result.prescription_data else None,
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
                "trust_reasons": result.trust_reasons.model_dump() if hasattr(result.trust_reasons, "model_dump") else {},
                "scorer_confidence": result.scorer_confidence,
                "citations": [c.model_dump() for c in result.citations],
                "guidelines_used": [g.model_dump() for g in result.guidelines_used],
                "agents_used": result.agents_used,
                "total_time_ms": result.total_time_ms,
                "language": result.language,
                "priority_country": result.priority_country,
                "izlem_brief_pdf": result.izlem_brief_pdf,
                "prescription_data": result.prescription_data.model_dump() if result.prescription_data else None,
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

    # Also write to global patient cache (3-hour TTL) for cross-session reuse
    pid = (
        masked["masked_record"].get("patient", {}).get("protocol_no")
        or masked["masked_record"].get("patient", {}).get("patient_id")
        or masked["masked_record"].get("protocol_no")
    )
    if pid:
        await set_global_patient_cache(pid, masked["masked_record"])

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
        raw_summary = patient_ctx.get("summary", "Patient data loaded.")
        # Ensure summary is a string — backend may store it as a dict
        if isinstance(raw_summary, dict):
            import json as _json
            summary = _json.dumps(raw_summary, ensure_ascii=False)
        else:
            summary = str(raw_summary) if raw_summary is not None else None
    return SessionInfoResponse(**info, patient_summary=summary)


@router.get("/api/session/{session_id}/messages")
async def session_messages(session_id: str):
    """Return full conversation history for a session.

    Messages include role, content, and metadata (citations, trust scores, etc.)
    so the frontend can fully restore a previous conversation.
    """
    mem = SessionMemory(session_id)
    history = await mem.get_history(last_n=100)
    patient_ctx = await mem.get_patient_context()
    return {
        "session_id": session_id,
        "messages": history,
        "patient_context": patient_ctx,
    }


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


# ── Patient Reports ──


class ReportSearchRequest(BaseModel):
    query: str
    limit: int = 5


@router.post("/api/reports/fetch/{protocol_id}")
async def fetch_reports_endpoint(protocol_id: str):
    """Trigger report download, index, and brief generation for a patient.

    Downloads all reports from the EHR, indexes them for search,
    and generates a comprehensive patient brief.
    """
    try:
        fetch_result = await auto_fetch_reports(protocol_id)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except RuntimeError as e:
        raise HTTPException(502, str(e))

    manifest = fetch_result["manifest"]
    reports_dir = fetch_result["reports_dir"]

    # Index for RAG search and generate brief in parallel
    async def _index():
        return await index_reports(protocol_id, manifest, reports_dir)

    async def _brief():
        return await _reports_agent.generate_brief(
            protocol_id=protocol_id,
            manifest=manifest,
            reports_dir=reports_dir,
        )

    chunk_count, brief = await asyncio.gather(
        _index(), _brief(), return_exceptions=False,
    )

    return {
        "success": True,
        "protocol_id": protocol_id,
        "total_reports": fetch_result["total"],
        "downloaded": fetch_result["downloaded"],
        "failed": fetch_result["failed"],
        "chunks_indexed": chunk_count,
        "brief_length": len(brief) if isinstance(brief, str) else 0,
    }


@router.get("/api/reports/{protocol_id}/manifest")
async def get_reports_manifest(protocol_id: str):
    """Return the report manifest for a patient, including PACS metadata."""
    full = get_manifest_with_pacs(protocol_id)
    if full is None:
        raise HTTPException(404, f"No reports found for protocol {protocol_id}")
    return {
        "protocol_id": protocol_id,
        "patient_id": full.get("patient_id", protocol_id),
        "pacs_all_studies": full.get("pacs_all_studies"),
        "manifest": full.get("reports", []),
        "total": len(full.get("reports", [])),
    }


@router.get("/api/reports/{protocol_id}/file/{filename:path}")
async def serve_report_file(protocol_id: str, filename: str):
    """Serve a PDF or TXT report file."""
    reports_dir = get_reports_dir(protocol_id)
    file_path = reports_dir / filename

    # Security: prevent directory traversal
    try:
        file_path = file_path.resolve()
        reports_dir_resolved = reports_dir.resolve()
    except Exception:
        raise HTTPException(403, "Invalid path")

    if not str(file_path).startswith(str(reports_dir_resolved)):
        raise HTTPException(403, "Access denied")

    if not file_path.exists():
        raise HTTPException(404, f"File not found: {filename}")

    # Determine media type
    suffix = file_path.suffix.lower()
    media_types = {
        ".pdf": "application/pdf",
        ".txt": "text/plain; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".rtf": "application/rtf",
    }
    media_type = media_types.get(suffix, "application/octet-stream")

    # Use Content-Disposition: inline so PDFs render in iframes instead of downloading
    # RFC 5987: encode non-ASCII filenames with filename* to avoid UnicodeEncodeError
    from urllib.parse import quote
    ascii_name = filename.encode("ascii", "replace").decode("ascii")
    utf8_name = quote(filename, safe="")
    headers = {
        "Content-Disposition": f"inline; filename=\"{ascii_name}\"; filename*=UTF-8''{utf8_name}"
    }
    return FileResponse(
        path=str(file_path),
        media_type=media_type,
        headers=headers,
    )


@router.get("/api/reports/{protocol_id}/trends")
async def get_lab_trends(protocol_id: str):
    """Return lab value trends for a patient."""
    manifest = get_manifest(protocol_id)
    if manifest is None:
        raise HTTPException(404, f"No reports found for protocol {protocol_id}")

    reports_dir = str(get_reports_dir(protocol_id))
    trends = aggregate_trends(manifest, reports_dir)

    abnormal = trends.pop("_abnormal_summary", [])
    lab_count_info = trends.pop("_lab_reports_parsed", [{}])
    lab_count = lab_count_info[0].get("count", 0) if lab_count_info else 0

    return {
        "protocol_id": protocol_id,
        "trends": trends,
        "abnormal_summary": abnormal,
        "lab_reports_parsed": lab_count,
        "unique_tests": len(trends),
    }


@router.post("/api/reports/{protocol_id}/search")
async def search_reports_endpoint(protocol_id: str, req: ReportSearchRequest):
    """Search across indexed report chunks using keyword matching."""
    if not reports_exist(protocol_id):
        raise HTTPException(404, f"No reports indexed for protocol {protocol_id}")

    results = await rag_search_reports(protocol_id, req.query, limit=req.limit)
    return {
        "protocol_id": protocol_id,
        "query": req.query,
        "results": results,
        "total": len(results),
    }


@router.get("/api/reports/{protocol_id}/brief")
async def get_patient_brief(protocol_id: str):
    """Return the generated patient brief, or 404 if not yet generated."""
    brief = await get_report_brief(protocol_id)
    if brief is None:
        raise HTTPException(
            404,
            f"No brief generated for protocol {protocol_id}. "
            "POST /api/reports/fetch/{protocol_id} first.",
        )
    return {"protocol_id": protocol_id, "brief": brief}


# ── Reader-mode proxy for X-Frame-Options blocked sites ──


@router.get("/api/reader")
async def reader_proxy(url: str):
    """Fetch a URL and return extracted article content as clean HTML.

    Used by the frontend when an iframe is blocked by X-Frame-Options.
    Extracts title, author, date, main content, and metadata.
    Results are cached for 10 minutes.
    """
    if not url or not url.startswith("http"):
        raise HTTPException(400, "Valid HTTP(S) URL required")

    from src.backend.tools.reader_proxy import fetch_and_extract

    try:
        result = await fetch_and_extract(url)
    except Exception as e:
        raise HTTPException(502, f"Could not fetch article: {str(e)[:200]}")

    return result


# ── PACS Viewer Links ──


class PacsLinkRequest(BaseModel):
    report_id: str | None = None
    accession_number: str | None = None


@router.post("/api/reports/{protocol_id}/pacs/refresh")
async def refresh_pacs_links_endpoint(protocol_id: str):
    """Refresh all PACS links for a patient (re-sign with fresh timestamps).

    PACS URLs contain a SHA1 signature with a timestamp, so they expire.
    This endpoint regenerates all links without re-downloading reports.
    """
    if not reports_exist(protocol_id):
        raise HTTPException(404, f"No reports found for protocol {protocol_id}")

    try:
        result = refresh_all_pacs_links(protocol_id)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))

    return {
        "success": True,
        "protocol_id": protocol_id,
        **result,
    }


@router.post("/api/reports/{protocol_id}/pacs/link")
async def get_pacs_link_endpoint(protocol_id: str, req: PacsLinkRequest):
    """Generate a fresh PACS link for a specific report or all studies.

    If accession_number is provided, generates a show_study link.
    If only report_id is provided, looks up the accession number from manifest
    and tries to extract it from the report text file as a fallback.
    If neither, generates an all-studies link.
    """
    import re
    import logging
    pacs_log = logging.getLogger("cerebralink.pacs")

    acc_no = req.accession_number
    pacs_log.info(
        "PACS link request: protocol=%s report_id=%s accession_number=%s",
        protocol_id, req.report_id, req.accession_number,
    )

    # If report_id provided but no accession_number, look it up from pacs_links.json first, then manifest
    if req.report_id and not acc_no:
        # Try pacs_links.json first — it has pre-extracted accession numbers from the download script
        pacs_links_data = get_pacs_links(protocol_id)
        if pacs_links_data and pacs_links_data.get("studies"):
            for study in pacs_links_data["studies"]:
                if str(study.get("report_id")) == str(req.report_id) and study.get("accession_number"):
                    acc_no = study["accession_number"]
                    pacs_log.info(
                        "Found accession in pacs_links.json: report_id=%s accession=%s",
                        req.report_id, acc_no,
                    )
                    break

        # Fallback: look up in manifest
        manifest = get_manifest(protocol_id)
        pacs_log.info(
            "Looking up accession in manifest: manifest_exists=%s entries=%d pacs_links_hit=%s",
            manifest is not None, len(manifest) if manifest else 0, bool(acc_no),
        )
        if manifest and not acc_no:
            found_entry = False
            for entry in manifest:
                if str(entry.get("report_id")) == str(req.report_id):
                    found_entry = True
                    acc_no = entry.get("accession_number")
                    pacs_log.info(
                        "Found manifest entry: report_id=%s report_type=%s accession=%s text_file=%s",
                        entry.get("report_id"), entry.get("report_type"),
                        acc_no, entry.get("text_file"),
                    )
                    # If accession still missing, try to extract from report text file
                    if not acc_no and entry.get("text_file"):
                        try:
                            text_path = get_reports_dir(protocol_id) / entry["text_file"]
                            pacs_log.info(
                                "Trying text extraction: path=%s exists=%s",
                                text_path, text_path.exists(),
                            )
                            if text_path.exists():
                                text = text_path.read_text(encoding="utf-8")[:3000]
                                for pattern in [
                                    r'Eri[sş]im\s+Numaras[ıi]\s*[:=]\s*(\d+)',
                                    r'Accession\s*(?:No|Number|#|ID)?\s*[:=]\s*(\d+)',
                                    r'Eri[sş]im\s+No\s*[:=]\s*(\d+)',
                                    r'AccessionNumber\s*[:=]\s*(\d+)',
                                    r'Erisim\s*[:=]\s*(\d+)',
                                ]:
                                    m = re.search(pattern, text, re.IGNORECASE)
                                    if m:
                                        acc_no = m.group(1)
                                        entry["accession_number"] = acc_no
                                        pacs_log.info(
                                            "Extracted accession from text: %s", acc_no,
                                        )
                                        break
                                if not acc_no:
                                    # Also try the PDF file itself if it exists
                                    pdf_file = entry.get("file")
                                    if pdf_file:
                                        pdf_path = get_reports_dir(protocol_id) / pdf_file
                                        if pdf_path.exists():
                                            try:
                                                import fitz
                                                pdf_doc = fitz.open(str(pdf_path))
                                                pdf_text = ""
                                                for page in pdf_doc[:3]:
                                                    pdf_text += page.get_text()
                                                pdf_doc.close()
                                                for pattern in [
                                                    r'Eri[sş]im\s+Numaras[ıi]\s*[:=]\s*(\d+)',
                                                    r'Accession\s*(?:No|Number|#|ID)?\s*[:=]\s*(\d+)',
                                                ]:
                                                    m = re.search(pattern, pdf_text, re.IGNORECASE)
                                                    if m:
                                                        acc_no = m.group(1)
                                                        entry["accession_number"] = acc_no
                                                        pacs_log.info(
                                                            "Extracted accession from PDF: %s", acc_no,
                                                        )
                                                        break
                                            except Exception as e:
                                                pacs_log.debug("PDF text extraction failed: %s", e)
                                if not acc_no:
                                    pacs_log.info(
                                        "No accession found in text. report_type_swc=%s First 200 chars: %s",
                                        entry.get("report_type_swc", "?"),
                                        text[:200].replace("\n", " "),
                                    )
                        except Exception as e:
                            pacs_log.warning(
                                "Text extraction failed: %s", e, exc_info=True,
                            )
                    break
            if not found_entry:
                pacs_log.warning(
                    "No manifest entry matched report_id=%s. Available IDs: %s",
                    req.report_id,
                    [e.get("report_id") for e in manifest[:10]],
                )
    elif not req.report_id and not acc_no:
        pacs_log.info("No report_id or accession — generating all-studies link")

    link = get_fresh_pacs_link(protocol_id, acc_no)
    pacs_log.info(
        "PACS link generated: cmd=%s accession=%s url_len=%d",
        link.get("uniview_cmd"), link.get("accession_number"), len(link.get("url", "")),
    )
    return {
        "success": True,
        "protocol_id": protocol_id,
        **link,
    }


# ── Episodes (Yatış + Poliklinik) ──


class EpisodeSearchRequest(BaseModel):
    query: str
    limit: int = 5
    episode_type: str | None = None  # "yatis", "poli", or null (both)


@router.post("/api/episodes/fetch/{protocol_id}")
async def fetch_episodes_endpoint(protocol_id: str):
    """Trigger episode download and indexing for a patient.

    Downloads all episodes (yatış + poliklinik) from the EHR,
    indexes them for search, and generates a summary.
    """
    try:
        fetch_result = await auto_fetch_episodes(protocol_id)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except RuntimeError as e:
        raise HTTPException(502, str(e))

    manifest = fetch_result["manifest"]
    episodes_dir = fetch_result["episodes_dir"]

    # Index for RAG search and generate summary in parallel
    async def _index():
        return await index_episodes(protocol_id, manifest, episodes_dir)

    async def _summary():
        return await _episodes_agent.generate_summary(
            protocol_id=protocol_id,
            manifest=manifest,
            episodes_dir=episodes_dir,
        )

    chunk_counts, summary = await asyncio.gather(
        _index(), _summary(), return_exceptions=False,
    )

    return {
        "success": True,
        "protocol_id": protocol_id,
        "total_episodes": fetch_result["total"],
        "yatis_count": fetch_result["yatis_count"],
        "poli_count": fetch_result["poli_count"],
        "chunks_indexed": chunk_counts if isinstance(chunk_counts, dict) else {},
        "summary_length": len(summary) if isinstance(summary, str) else 0,
        "from_cache": fetch_result.get("from_cache", False),
    }


@router.get("/api/episodes/{protocol_id}/manifest")
async def get_episodes_manifest_endpoint(protocol_id: str):
    """Return the episode manifest for a patient."""
    full = get_full_episodes_manifest(protocol_id)
    if full is None:
        raise HTTPException(404, f"No episodes found for protocol {protocol_id}")

    episodes = full.get("episodes", [])
    yatis = [e for e in episodes if e.get("is_hospitalization")]
    poli = [e for e in episodes if not e.get("is_hospitalization")]

    return {
        "protocol_id": protocol_id,
        "patient_id": full.get("patient_id", protocol_id),
        "total": len(episodes),
        "yatis_count": len(yatis),
        "poli_count": len(poli),
        "episodes": episodes,
    }


@router.get("/api/episodes/{protocol_id}/yatis")
async def get_yatis_summary_endpoint(protocol_id: str):
    """Return the yatış (hospitalization) summary for a patient."""
    summary = get_yatis_summary(protocol_id)
    if summary is None:
        raise HTTPException(404, f"No yatış data found for protocol {protocol_id}")
    return summary


@router.get("/api/episodes/{protocol_id}/file/{filename:path}")
async def serve_episode_file(protocol_id: str, filename: str):
    """Serve an episode text file (YATIS_*.txt or POLI_*.txt)."""
    ep_dir = get_episodes_dir(protocol_id)
    file_path = ep_dir / filename

    # Security: prevent directory traversal
    try:
        file_path = file_path.resolve()
        ep_dir_resolved = ep_dir.resolve()
    except Exception:
        raise HTTPException(403, "Invalid path")

    if not str(file_path).startswith(str(ep_dir_resolved)):
        raise HTTPException(403, "Access denied")

    if not file_path.exists():
        raise HTTPException(404, f"File not found: {filename}")

    headers = {"Content-Disposition": f'inline; filename="{filename}"'}
    return FileResponse(
        path=str(file_path),
        media_type="text/plain; charset=utf-8",
        headers=headers,
    )


@router.post("/api/episodes/{protocol_id}/search")
async def search_episodes_endpoint(protocol_id: str, req: EpisodeSearchRequest):
    """Search across indexed episode chunks using keyword matching."""
    if not episodes_exist(protocol_id):
        raise HTTPException(404, f"No episodes indexed for protocol {protocol_id}")

    results = await rag_search_episodes(
        protocol_id, req.query, limit=req.limit, episode_type=req.episode_type,
    )
    return {
        "protocol_id": protocol_id,
        "query": req.query,
        "episode_type": req.episode_type,
        "results": results,
        "total": len(results),
    }


@router.get("/api/episodes/{protocol_id}/summary")
async def get_episodes_summary_endpoint(protocol_id: str):
    """Return the generated episode summary, or 404 if not yet generated."""
    summary = await get_episodes_summary(protocol_id)
    if summary is None:
        raise HTTPException(
            404,
            f"No summary generated for protocol {protocol_id}. "
            "POST /api/episodes/fetch/{protocol_id} first.",
        )
    return {"protocol_id": protocol_id, "summary": summary}


@router.get("/api/episodes/{protocol_id}/cross-match")
async def cross_match_endpoint(protocol_id: str):
    """Cross-match episodes with reports by date + facility.

    Returns matched pairs of episodes and their associated reports.
    """
    ep_manifest = get_episodes_manifest(protocol_id)
    if ep_manifest is None:
        raise HTTPException(404, f"No episodes found for protocol {protocol_id}")

    rpt_manifest = get_manifest(protocol_id)
    if rpt_manifest is None:
        return {
            "protocol_id": protocol_id,
            "matches": [],
            "message": "No reports available for cross-matching",
        }

    matches = cross_match_reports(ep_manifest, rpt_manifest)
    return {
        "protocol_id": protocol_id,
        "total_matches": len(matches),
        "matches": matches,
    }


# ── Izlem (Monitoring Data) ──


class IzlemSearchRequest(BaseModel):
    query: str
    limit: int = 5
    data_type: str | None = None  # "vitals", "meds", "doctor_notes", "nurse_notes", or null (all)


@router.post("/api/izlem/fetch/{protocol_id}")
async def fetch_izlem_endpoint(protocol_id: str, refresh: bool = False):
    """Fetch izlem (monitoring) data for a patient.

    Downloads monitoring notes, vitals, medication admin records,
    indexes them for search, and returns a summary.
    """
    if not refresh and izlem_exists(protocol_id):
        izlem_data = get_izlem_data(protocol_id)
        if izlem_data:
            ep_count = len(izlem_data.get("episodes", []))
            return {
                "success": True,
                "protocol_id": protocol_id,
                "total_episodes": ep_count,
                "from_cache": True,
            }

    try:
        izlem_data = await auto_fetch_izlem(protocol_id, refresh=refresh)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except RuntimeError as e:
        raise HTTPException(502, str(e))

    if not izlem_data:
        raise HTTPException(404, f"No monitoring data found for protocol {protocol_id}")

    # Index for RAG search
    try:
        await index_izlem(protocol_id, izlem_data)
    except Exception:
        pass  # Indexing is best-effort

    ep_count = len(izlem_data.get("episodes", []))
    return {
        "success": True,
        "protocol_id": protocol_id,
        "total_episodes": ep_count,
        "from_cache": False,
    }


@router.get("/api/izlem/{protocol_id}/data")
async def get_izlem_data_endpoint(protocol_id: str):
    """Return raw izlem data for a patient."""
    if not izlem_exists(protocol_id):
        raise HTTPException(404, f"No monitoring data found for protocol {protocol_id}")

    izlem_data = get_izlem_data(protocol_id)
    if not izlem_data:
        raise HTTPException(404, f"No monitoring data found for protocol {protocol_id}")

    episodes = izlem_data.get("episodes", [])
    return {
        "protocol_id": protocol_id,
        "meta": izlem_data.get("meta", {}),
        "total_episodes": len(episodes),
        "episodes": episodes,
    }


@router.post("/api/izlem/{protocol_id}/search")
async def search_izlem_endpoint(protocol_id: str, req: IzlemSearchRequest):
    """Search izlem data using RAG."""
    if not izlem_exists(protocol_id):
        raise HTTPException(404, f"No monitoring data indexed for protocol {protocol_id}")

    results = await rag_search_izlem(
        protocol_id, req.query, limit=req.limit, data_type=req.data_type,
    )
    return {
        "protocol_id": protocol_id,
        "query": req.query,
        "data_type": req.data_type,
        "results": results,
        "total": len(results),
    }


@router.post("/api/izlem/{protocol_id}/brief")
async def generate_izlem_brief(protocol_id: str, language: str = "en"):
    """Generate and return a PDF brief of patient monitoring data."""
    if not izlem_exists(protocol_id):
        raise HTTPException(404, f"No monitoring data found for protocol {protocol_id}")

    izlem_data = get_izlem_data(protocol_id)
    if not izlem_data:
        raise HTTPException(404, f"No monitoring data found for protocol {protocol_id}")

    try:
        pdf_path = await _izlem_agent.generate_pdf_brief(
            protocol_id=protocol_id,
            izlem_data=izlem_data,
            language=language,
        )
    except Exception as e:
        raise HTTPException(500, f"PDF generation failed: {str(e)[:200]}")

    return {
        "success": True,
        "protocol_id": protocol_id,
        "pdf_path": str(pdf_path),
        "filename": Path(pdf_path).name if pdf_path else None,
    }


@router.get("/api/izlem/{protocol_id}/pdf/{filename}")
async def serve_izlem_pdf(protocol_id: str, filename: str):
    """Serve a generated izlem PDF brief."""
    izlem_dir = get_izlem_dir(protocol_id)
    file_path = izlem_dir / filename

    # Security: prevent directory traversal
    try:
        file_path = file_path.resolve()
        izlem_dir_resolved = izlem_dir.resolve()
    except Exception:
        raise HTTPException(403, "Invalid path")

    if not str(file_path).startswith(str(izlem_dir_resolved)):
        raise HTTPException(403, "Access denied")

    if not file_path.exists():
        raise HTTPException(404, f"File not found: {filename}")

    from urllib.parse import quote
    ascii_name = filename.encode("ascii", "replace").decode("ascii")
    utf8_name = quote(filename, safe="")
    headers = {
        "Content-Disposition": f"inline; filename=\"{ascii_name}\"; filename*=UTF-8''{utf8_name}"
    }
    return FileResponse(
        path=str(file_path),
        media_type="application/pdf",
        headers=headers,
    )


# ── Knowledge Graph (Neo4j) ──


@router.get("/api/graph/status")
async def graph_status():
    """Check if Neo4j graph database is available."""
    return {"available": neo4j_available()}


@router.get("/api/graph/{patient_id}/patient")
async def get_patient_graph(patient_id: str):
    """Return patient history knowledge graph in ReactFlow format.

    Returns nodes (Patient, Episode, Diagnosis, Medication, etc.) and edges
    with layout positions. Falls back to empty graph if Neo4j is unavailable.
    """
    data = query_patient_graph(patient_id)
    return {
        "patient_id": patient_id,
        **data,
    }


@router.get("/api/graph/{patient_id}/reports")
async def get_reports_graph(patient_id: str):
    """Return reports knowledge graph in ReactFlow format.

    Returns nodes (Report, ReportType, PACSStudy, LabTest, etc.) and edges.
    """
    data = query_reports_graph(patient_id)
    return {
        "patient_id": patient_id,
        **data,
    }


@router.get("/api/graph/{patient_id}/episodes")
async def get_episodes_graph(patient_id: str):
    """Return episodes knowledge graph (Yatış + Poliklinik) in ReactFlow format."""
    data = query_episodes_graph(patient_id)
    return {
        "patient_id": patient_id,
        **data,
    }


@router.get("/api/graph/{patient_id}/full")
async def get_full_graph(patient_id: str):
    """Return combined patient + reports knowledge graph in ReactFlow format.

    Includes cross-references between reports and clinical episodes.
    """
    data = query_full_graph(patient_id)
    return {
        "patient_id": patient_id,
        **data,
    }


@router.post("/api/graph/{patient_id}/ingest")
async def trigger_graph_ingest(patient_id: str):
    """Manually trigger Neo4j ingestion for a patient.

    Ingests patient history from session and reports from disk.
    Primarily for debugging — normal ingestion happens automatically.
    """
    if not neo4j_available():
        raise HTTPException(503, "Neo4j is not available")

    results = {}

    # Try to get patient context from current session memory
    # (this is a manual trigger, so we ingest from reports on disk)
    if reports_exist(patient_id):
        manifest = get_manifest(patient_id)
        if manifest:
            reports_dir = str(get_reports_dir(patient_id))
            trends_resp = aggregate_trends(manifest, reports_dir)
            results["reports"] = ingest_reports(patient_id, manifest, trends_resp)

    if episodes_exist(patient_id):
        ep_manifest = get_episodes_manifest(patient_id)
        if ep_manifest:
            results["episodes"] = graph_ingest_episodes(patient_id, ep_manifest)

    return {
        "patient_id": patient_id,
        **results,
    }
