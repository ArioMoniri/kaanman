"""CerebraLink Orchestrator — the agent council coordinator.

Flow:
  1. Guardrail: Router classifies query (medical / greeting / off-topic)
  2. If non-medical → return direct response
  3. If protocol ID detected → auto-fetch patient data
  4. Fan-out: activated agents run in parallel
  5. Compose FAST answer → stream immediately
  6. Compose COMPLETE answer + Decision Tree (if needed) in parallel
  7. Trust scoring with per-dimension reasoning
  8. PHI regex check
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
import traceback
from typing import Any, Callable, Awaitable

from src.backend.agents.router import RouterAgent, RouteDecision
from src.backend.agents.clinical import ClinicalAgent
from src.backend.agents.research import ResearchAgent
from src.backend.agents.drug import DrugAgent
from src.backend.agents.prescription import PrescriptionAgent
from src.backend.agents.composer import ComposerAgent
from src.backend.agents.trust import TrustScorerAgent
from src.backend.agents.decision_tree import DecisionTreeAgent
from src.backend.agents.phi_masker import PhiMasker
from src.backend.agents.reports import ReportsAgent
from src.backend.agents.episodes import EpisodesAgent
from src.backend.core.memory import (
    AgentMemory, SharedMemory, SessionMemory,
    get_global_patient_cache, set_global_patient_cache,
)
from src.backend.api.schemas import (
    TrustScores, TrustReasons, GuidelineRef, Citation, AgentTiming,
    DecisionTree, DecisionTreeNode, DecisionTreeEdge,
    PrescriptionData, BrandOption,
)
from src.backend.tools.cerebral import auto_fetch_patient
from src.backend.tools.reports import auto_fetch_reports, reports_exist, get_manifest, get_reports_dir
from src.backend.tools.reports_rag import index_reports, get_report_brief, chunks_indexed
from src.backend.tools.episodes import (
    auto_fetch_episodes,
    episodes_exist,
    get_manifest as get_episodes_manifest,
    get_episodes_dir,
)
from src.backend.tools.episodes_rag import (
    index_episodes,
    get_episodes_summary,
    episodes_indexed as episodes_rag_indexed,
)
from src.backend.tools.graph import (
    neo4j_available,
    ingest_patient_history,
    ingest_reports as graph_ingest_reports,
    ingest_episodes as graph_ingest_episodes,
)
from src.backend.agents.izlem import IzlemAgent
from src.backend.tools.izlem import (
    auto_fetch_izlem,
    izlem_exists,
    get_izlem_data,
    cross_reference_with_episodes,
)
from src.backend.tools.izlem_rag import (
    index_izlem,
    izlem_indexed as izlem_rag_indexed,
)

StatusCallback = Callable[[dict[str, Any]], Awaitable[None]] | None

AGENT_LABELS = {
    "router": "Classifying query...",
    "patient_fetch": "Fetching patient data...",
    "reports_fetch": "Fetching patient reports...",
    "episodes_fetch": "Fetching episode history...",
    "reports_index": "Indexing reports & generating brief...",
    "episodes_index": "Indexing episodes & generating summary...",
    "clinical": "Deep clinical analysis...",
    "research": "Searching latest guidelines...",
    "drug": "Analyzing drug interactions & dosing...",
    "reports": "Analyzing patient reports...",
    "episodes": "Analyzing episode history...",
    "composer_fast": "Composing fast answer...",
    "composer_complete": "Composing complete analysis...",
    "decision_tree": "Generating decision tree...",
    "trust_scorer": "Evaluating confidence...",
    "prescription": "Writing prescription...",
    "izlem_fetch": "Fetching monitoring data...",
    "izlem_index": "Indexing monitoring records...",
    "izlem": "Analyzing monitoring data...",
    "izlem_pdf": "Generating izlem PDF brief...",
}


class OrchestratorResult:
    def __init__(self):
        self.fast_answer: str = ""
        self.complete_answer: str = ""
        self.trust_scores = TrustScores(
            evidence_quality=0, guideline_alignment=0,
            clinical_relevance=0, safety_check=0,
            completeness=0, source_recency=0,
        )
        self.trust_reasons = TrustReasons()
        self.scorer_confidence: int = 0
        self.guidelines_used: list[GuidelineRef] = []
        self.citations: list[Citation] = []
        self.agents_used: list[str] = []
        self.agent_timings: list[AgentTiming] = []
        self.total_time_ms: int = 0
        self.total_input_tokens: int = 0
        self.total_output_tokens: int = 0
        self.decision_tree: DecisionTree | None = None
        self.language: str = "en"
        self.priority_country: str = ""
        self.patient_context: dict | None = None
        self.izlem_brief_pdf: str | None = None
        self.prescription_data: PrescriptionData | None = None

    def model_dump(self) -> dict:
        return {
            "fast_answer": self.fast_answer,
            "complete_answer": self.complete_answer,
            "trust_scores": self.trust_scores.model_dump() if hasattr(self.trust_scores, "model_dump") else self.trust_scores,
            "trust_reasons": self.trust_reasons.model_dump() if hasattr(self.trust_reasons, "model_dump") else self.trust_reasons,
            "scorer_confidence": self.scorer_confidence,
            "guidelines_used": [g.model_dump() if hasattr(g, "model_dump") else g for g in self.guidelines_used],
            "citations": [c.model_dump() if hasattr(c, "model_dump") else c for c in self.citations],
            "agents_used": self.agents_used,
            "agent_timings": [t.model_dump() for t in self.agent_timings],
            "total_time_ms": self.total_time_ms,
            "total_input_tokens": self.total_input_tokens,
            "total_output_tokens": self.total_output_tokens,
            "decision_tree": self.decision_tree.model_dump() if self.decision_tree and hasattr(self.decision_tree, "model_dump") else self.decision_tree,
            "language": self.language,
            "priority_country": self.priority_country,
            "patient_context": self.patient_context,
            "izlem_brief_pdf": self.izlem_brief_pdf,
            "prescription_data": self.prescription_data.model_dump() if self.prescription_data else None,
        }


class Orchestrator:
    def __init__(self):
        self.router = RouterAgent()
        self.clinical = ClinicalAgent()
        self.research = ResearchAgent()
        self.drug = DrugAgent()
        self.prescription = PrescriptionAgent()
        self.reports_agent = ReportsAgent()
        self.episodes_agent = EpisodesAgent()
        self.composer = ComposerAgent()
        self.trust_scorer = TrustScorerAgent()
        self.decision_tree_agent = DecisionTreeAgent()
        self.phi_checker = PhiMasker()
        self.izlem_agent = IzlemAgent()

    async def _emit(self, on_status: StatusCallback, event: dict):
        if on_status:
            await on_status(event)

    def _timing(self, agent: str, t0: float, usage: dict) -> AgentTiming:
        return AgentTiming(
            agent=agent, time_ms=int((time.monotonic() - t0) * 1000),
            input_tokens=usage.get("input_tokens", 0),
            output_tokens=usage.get("output_tokens", 0),
        )

    async def run(
        self,
        message: str,
        patient_context: dict[str, Any] | None,
        history: list[dict],
        session_id: str,
        on_status: StatusCallback = None,
    ) -> OrchestratorResult:
        t_start = time.monotonic()
        result = OrchestratorResult()
        shared = SharedMemory(session_id)

        # Store patient context if already available from session
        if patient_context:
            result.patient_context = patient_context

        # ── 1. Route & guardrail ──
        await self._emit(on_status, {
            "agent": "router", "status": "running",
            "message": AGENT_LABELS["router"], "phase": "routing",
        })
        t0 = time.monotonic()
        route: RouteDecision = await self.router.classify(message, patient_context)
        timing_router = self._timing("router", t0, self.router.last_usage)
        result.agents_used.append("router")
        result.agent_timings.append(timing_router)
        result.language = route.language
        result.priority_country = route.priority_country
        await self._emit(on_status, {
            "agent": "router", "status": "done", "time_ms": timing_router.time_ms,
            "tokens": self.router.last_usage,
            "message": f"Route: {route.category} (urgency {route.urgency}/5)",
        })

        # ── Non-medical queries ──
        if not route.is_medical:
            result.fast_answer = route.direct_response
            result.complete_answer = route.direct_response
            result.total_time_ms = int((time.monotonic() - t_start) * 1000)
            result.total_input_tokens = timing_router.input_tokens
            result.total_output_tokens = timing_router.output_tokens
            await self._emit(on_status, {
                "_type": "fast_answer",
                "fast_answer": result.fast_answer,
                "guidelines_used": [], "citations": [],
            })
            return result

        await shared.put("route", {
            "category": route.category, "urgency": route.urgency,
            "guideline_countries": route.guideline_countries,
        })

        # ── 2. Auto-fetch patient data + reports in parallel ──
        detected_pid = route.detected_protocol_id

        # Extract protocol ID from existing patient context for follow-up questions
        if not detected_pid and patient_context:
            pc = patient_context.get("patient", patient_context)
            detected_pid = (
                pc.get("protocol_no")
                or pc.get("patient_id")
                or pc.get("protocol_id")
            ) or None

        reports_manifest = None
        reports_dir_path = None
        episodes_manifest = None
        episodes_dir_path = None
        izlem_data = None

        if detected_pid and not patient_context:
            # Check global patient cache first (3-hour TTL, cross-session)
            # This avoids re-fetching the same patient from EHR API when:
            # - Opening a chat from history within 3 hours
            # - Starting a new chat for a recently-queried patient
            cached_patient = await get_global_patient_cache(detected_pid)
            if cached_patient:
                patient_context = cached_patient
                mem = SessionMemory(session_id)
                await mem.set_patient_context(patient_context)
                result.patient_context = patient_context
                result.agents_used.append("patient_fetch")
                result.agent_timings.append(AgentTiming(agent="patient_fetch", time_ms=0))
                await self._emit(on_status, {
                    "agent": "patient_fetch", "status": "done",
                    "time_ms": 0,
                    "message": "Patient data loaded from cache (< 3h)",
                })
                # Neo4j: ingest patient history in background (non-blocking)
                if neo4j_available() and patient_context:
                    try:
                        ingest_patient_history(patient_context)
                    except Exception:
                        pass

            if not patient_context:
                # No cache hit — fetch fresh from EHR API
                await self._emit(on_status, {
                    "agent": "patient_fetch", "status": "running",
                    "message": f"Fetching patient {detected_pid}...",
                    "phase": "patient_fetch",
                })

                # Fetch patient data and reports in parallel
                t0 = time.monotonic()

                async def _fetch_patient_data():
                    raw_patient = await auto_fetch_patient(detected_pid)
                    masked = await self.phi_checker.mask_patient_record(raw_patient)
                    masked_data = masked.get("masked_record", raw_patient)
                    # Store in global cache for 3-hour reuse across sessions
                    await set_global_patient_cache(detected_pid, masked_data)
                    return masked_data

                async def _fetch_reports_data():
                    """Fetch reports if not already on disk."""
                    if reports_exist(detected_pid):
                        return get_manifest(detected_pid), str(get_reports_dir(detected_pid))
                    try:
                        await self._emit(on_status, {
                            "agent": "reports_fetch", "status": "running",
                            "message": f"Fetching reports for {detected_pid}...",
                            "phase": "patient_fetch",
                        })
                        rdata = await auto_fetch_reports(detected_pid)
                        return rdata["manifest"], rdata["reports_dir"]
                    except Exception as re:
                        logging.getLogger("cerebralink.orchestrator").warning(
                            "Reports fetch failed for %s: %s", detected_pid, re
                        )
                        return None, None

                async def _fetch_episodes_data():
                    """Fetch episodes if not already on disk."""
                    if episodes_exist(detected_pid):
                        return get_episodes_manifest(detected_pid), str(get_episodes_dir(detected_pid))
                    try:
                        await self._emit(on_status, {
                            "agent": "episodes_fetch", "status": "running",
                            "message": f"Fetching episodes for {detected_pid}...",
                            "phase": "patient_fetch",
                        })
                        edata = await auto_fetch_episodes(detected_pid)
                        return edata["manifest"], edata["episodes_dir"]
                    except Exception as ee:
                        logging.getLogger("cerebralink.orchestrator").warning(
                            "Episodes fetch failed for %s: %s", detected_pid, ee
                        )
                        return None, None

                async def _fetch_izlem_data():
                    """Fetch izlem (monitoring) data if available."""
                    if izlem_exists(detected_pid):
                        return get_izlem_data(detected_pid)
                    try:
                        await self._emit(on_status, {
                            "agent": "izlem_fetch", "status": "running",
                            "message": f"Fetching monitoring data for {detected_pid}...",
                            "phase": "patient_fetch",
                        })
                        idata = await auto_fetch_izlem(detected_pid)
                        # auto_fetch_izlem returns wrapper {"izlem_data": {...}, ...}
                        # Unwrap to get raw izlem data with "episodes" key
                        if isinstance(idata, dict) and "izlem_data" in idata:
                            return idata["izlem_data"]
                        return idata
                    except Exception as ie:
                        logging.getLogger("cerebralink.orchestrator").warning(
                            "Izlem fetch failed for %s: %s", detected_pid, ie,
                            exc_info=True,
                        )
                        return None

                try:
                    # return_exceptions=True so one failure doesn't cancel the rest
                    patient_result, reports_result, episodes_result, izlem_result = await asyncio.gather(
                        _fetch_patient_data(),
                        _fetch_reports_data(),
                        _fetch_episodes_data(),
                        _fetch_izlem_data(),
                        return_exceptions=True,
                    )

                    t_fetch = int((time.monotonic() - t0) * 1000)

                    # ── Handle patient data result ──
                    if isinstance(patient_result, Exception):
                        tb = "".join(traceback.format_exception(type(patient_result), patient_result, patient_result.__traceback__))
                        logging.getLogger("cerebralink.orchestrator").error(
                            "Patient fetch error for protocol %s:\n%s", detected_pid, tb
                        )
                        await self._emit(on_status, {
                            "agent": "patient_fetch", "status": "error",
                            "time_ms": t_fetch,
                            "message": f"Patient fetch failed: {type(patient_result).__name__}: {patient_result}",
                        })
                    else:
                        patient_context = patient_result
                        mem = SessionMemory(session_id)
                        await mem.set_patient_context(patient_context)
                        result.patient_context = patient_context

                        # Neo4j: ingest patient history in background (non-blocking)
                        if neo4j_available() and patient_context:
                            try:
                                ingest_patient_history(patient_context)
                            except Exception:
                                pass  # Graph ingestion is best-effort

                        result.agents_used.append("patient_fetch")
                        result.agent_timings.append(AgentTiming(agent="patient_fetch", time_ms=t_fetch))
                        await self._emit(on_status, {
                            "agent": "patient_fetch", "status": "done",
                            "time_ms": t_fetch, "message": "Patient data loaded & PHI-masked",
                        })

                    # ── Handle reports result (may be tuple or exception) ──
                    if isinstance(reports_result, Exception):
                        logging.getLogger("cerebralink.orchestrator").warning(
                            "Reports fetch failed for %s: %s", detected_pid, reports_result
                        )
                    elif isinstance(reports_result, tuple):
                        reports_manifest, reports_dir_path = reports_result
                        if reports_manifest:
                            await self._emit(on_status, {
                                "agent": "reports_fetch", "status": "done",
                                "time_ms": t_fetch,
                                "message": f"Reports loaded: {len(reports_manifest)} reports",
                            })

                    # ── Handle episodes result (may be tuple or exception) ──
                    if isinstance(episodes_result, Exception):
                        logging.getLogger("cerebralink.orchestrator").warning(
                            "Episodes fetch failed for %s: %s", detected_pid, episodes_result
                        )
                    elif isinstance(episodes_result, tuple):
                        episodes_manifest, episodes_dir_path = episodes_result
                        if episodes_manifest:
                            yatis_n = sum(1 for e in episodes_manifest if e.get("is_hospitalization"))
                            poli_n = len(episodes_manifest) - yatis_n
                            await self._emit(on_status, {
                                "agent": "episodes_fetch", "status": "done",
                                "time_ms": t_fetch,
                                "message": f"Episodes loaded: {yatis_n} yatış, {poli_n} poliklinik",
                            })

                    # ── Handle izlem result (may be dict, None, or exception) ──
                    if isinstance(izlem_result, Exception):
                        logging.getLogger("cerebralink.orchestrator").warning(
                            "Izlem fetch failed for %s: %s", detected_pid, izlem_result
                        )
                    elif isinstance(izlem_result, dict) and izlem_result:
                        izlem_data = izlem_result
                        ep_count = len(izlem_data.get("episodes", []))
                        await self._emit(on_status, {
                            "agent": "izlem_fetch", "status": "done",
                            "time_ms": t_fetch,
                            "message": f"Monitoring data loaded: {ep_count} episodes",
                        })

                except Exception as e:
                    t_fetch = int((time.monotonic() - t0) * 1000)
                    tb = traceback.format_exc()
                    await self._emit(on_status, {
                        "agent": "patient_fetch", "status": "error",
                        "time_ms": t_fetch,
                        "message": f"Patient fetch failed: {type(e).__name__}: {e}",
                    })
                    logging.getLogger("cerebralink.orchestrator").error(
                        "Patient fetch error for protocol %s:\n%s", detected_pid, tb
                    )

        # ── 2a. Load reports/episodes from disk for follow-up questions ──
        if detected_pid and reports_manifest is None and reports_exist(detected_pid):
            reports_manifest = get_manifest(detected_pid)
            reports_dir_path = str(get_reports_dir(detected_pid))

        if detected_pid and episodes_manifest is None and episodes_exist(detected_pid):
            episodes_manifest = get_episodes_manifest(detected_pid)
            episodes_dir_path = str(get_episodes_dir(detected_pid))

        if detected_pid and izlem_data is None and izlem_exists(detected_pid):
            izlem_data = get_izlem_data(detected_pid)

        # ── 2b. Index reports + generate brief (if not cached / expired) ──
        if detected_pid and reports_manifest and reports_dir_path:
            brief_cached = await get_report_brief(detected_pid)
            rag_indexed = await chunks_indexed(detected_pid)
            if not brief_cached or not rag_indexed:
                await self._emit(on_status, {
                    "agent": "reports_index", "status": "running",
                    "message": "Indexing reports & generating brief...",
                    "phase": "patient_fetch",
                })
                t0_idx = time.monotonic()
                try:
                    await asyncio.gather(
                        index_reports(detected_pid, reports_manifest, reports_dir_path),
                        self.reports_agent.generate_brief(
                            protocol_id=detected_pid,
                            manifest=reports_manifest,
                            reports_dir=reports_dir_path,
                            language=result.language,
                        ),
                        return_exceptions=True,
                    )
                    t_idx = int((time.monotonic() - t0_idx) * 1000)
                    result.agents_used.append("reports_index")
                    result.agent_timings.append(AgentTiming(agent="reports_index", time_ms=t_idx))
                    await self._emit(on_status, {
                        "agent": "reports_index", "status": "done",
                        "time_ms": t_idx, "message": "Reports indexed & brief generated",
                    })
                except Exception:
                    pass

            # Neo4j: ingest reports into graph (best-effort, non-blocking)
            if neo4j_available():
                try:
                    graph_ingest_reports(detected_pid, reports_manifest)
                except Exception:
                    pass

        # ── 2c. Index episodes + generate summary (if not cached / expired) ──
        if detected_pid and episodes_manifest and episodes_dir_path:
            summary_cached = await get_episodes_summary(detected_pid)
            rag_indexed = await episodes_rag_indexed(detected_pid)
            if not summary_cached or not rag_indexed:
                await self._emit(on_status, {
                    "agent": "episodes_index", "status": "running",
                    "message": "Indexing episodes & generating summary...",
                    "phase": "patient_fetch",
                })
                t0_eidx = time.monotonic()
                try:
                    await asyncio.gather(
                        index_episodes(detected_pid, episodes_manifest, episodes_dir_path),
                        self.episodes_agent.generate_summary(
                            protocol_id=detected_pid,
                            manifest=episodes_manifest,
                            episodes_dir=episodes_dir_path,
                            language=result.language,
                        ),
                        return_exceptions=True,
                    )
                    t_eidx = int((time.monotonic() - t0_eidx) * 1000)
                    result.agents_used.append("episodes_index")
                    result.agent_timings.append(AgentTiming(agent="episodes_index", time_ms=t_eidx))
                    await self._emit(on_status, {
                        "agent": "episodes_index", "status": "done",
                        "time_ms": t_eidx, "message": "Episodes indexed & summary generated",
                    })
                except Exception:
                    pass

            # Neo4j: ingest episodes into graph (best-effort)
            if neo4j_available():
                try:
                    graph_ingest_episodes(detected_pid, episodes_manifest)
                except Exception:
                    pass

        # ── 2d. Index izlem data (if not cached) ──
        if detected_pid and izlem_data:
            rag_indexed = await izlem_rag_indexed(detected_pid)
            if not rag_indexed:
                await self._emit(on_status, {
                    "agent": "izlem_index", "status": "running",
                    "message": "Indexing monitoring records...",
                    "phase": "patient_fetch",
                })
                t0_iidx = time.monotonic()
                try:
                    await index_izlem(detected_pid, izlem_data)
                    # Cross-reference with episodes if both available
                    if episodes_manifest:
                        cross_reference_with_episodes(izlem_data, episodes_manifest)
                    t_iidx = int((time.monotonic() - t0_iidx) * 1000)
                    result.agents_used.append("izlem_index")
                    result.agent_timings.append(AgentTiming(agent="izlem_index", time_ms=t_iidx))
                    await self._emit(on_status, {
                        "agent": "izlem_index", "status": "done",
                        "time_ms": t_iidx, "message": "Monitoring records indexed",
                    })
                except Exception:
                    pass

        # ── 3. Fan-out: parallel agents ──
        agent_map: dict[str, tuple] = {}
        if route.needs_clinical:
            agent_map["clinical"] = (self.clinical, self.clinical.analyze, (message, patient_context, history))
        if route.needs_research:
            agent_map["research"] = (self.research, self.research.search, (message, route.guideline_countries))
        if route.needs_drug:
            agent_map["drug"] = (self.drug, self.drug.analyze, (message, patient_context, route.priority_country))

        # Reports agent runs in parallel when we have patient context + reports
        if route.needs_patient_context and detected_pid and reports_manifest:
            fast_mode = not route.needs_clinical  # fast when no deep analysis needed
            agent_map["reports"] = (
                self.reports_agent,
                self.reports_agent.analyze_for_council,
                (message, detected_pid, fast_mode, route.language),
            )

        # Episodes agent runs in parallel when we have episode data
        if route.needs_patient_context and detected_pid and episodes_manifest:
            fast_mode = not route.needs_clinical
            agent_map["episodes"] = (
                self.episodes_agent,
                self.episodes_agent.analyze_for_council,
                (message, detected_pid, fast_mode, route.language),
            )

        # Izlem agent runs in parallel when we have monitoring data
        if route.needs_izlem and izlem_data:
            agent_map["izlem"] = (
                self.izlem_agent,
                self.izlem_agent.analyze_for_council,
                (message, detected_pid, izlem_data),
            )

        if not agent_map:
            agent_map["clinical"] = (self.clinical, self.clinical.analyze, (message, patient_context, history))

        for name in agent_map:
            await self._emit(on_status, {
                "agent": name, "status": "running",
                "message": AGENT_LABELS.get(name, f"{name} working..."), "phase": "council",
            })

        async def _timed_agent(name, agent_obj, fn, args):
            t0 = time.monotonic()
            agent_mem = AgentMemory(session_id, name)
            output = await fn(*args)
            elapsed = int((time.monotonic() - t0) * 1000)
            usage = agent_obj.last_usage
            await agent_mem.put("last_output", output)
            if isinstance(output, dict):
                summary = output.get("analysis", output.get("synthesis", ""))
                if isinstance(summary, str) and len(summary) > 500:
                    summary = summary[:500]
                await shared.put(f"agent_output:{name}", summary)
            await self._emit(on_status, {
                "agent": name, "status": "done", "time_ms": elapsed,
                "tokens": usage, "message": f"{name} complete",
            })
            return name, output, elapsed, usage

        tasks = [asyncio.create_task(_timed_agent(n, i[0], i[1], i[2])) for n, i in agent_map.items()]
        agent_outputs: dict[str, Any] = {}
        for coro in asyncio.as_completed(tasks):
            try:
                name, output, elapsed, usage = await coro
                agent_outputs[name] = output
                result.agents_used.append(name)
                result.agent_timings.append(AgentTiming(
                    agent=name, time_ms=elapsed,
                    input_tokens=usage["input_tokens"], output_tokens=usage["output_tokens"],
                ))
            except Exception:
                pass

        # ── 3b. Prescription agent (runs after drug results are available) ──
        if route.needs_drug and "drug" in agent_outputs:
            drug_out = agent_outputs["drug"]
            drug_result_text = ""
            if isinstance(drug_out, dict):
                drug_result_text = drug_out.get("analysis", "")
            if drug_result_text:
                await self._emit(on_status, {
                    "agent": "prescription", "status": "running",
                    "message": AGENT_LABELS["prescription"], "phase": "council",
                })
                t0_rx = time.monotonic()
                try:
                    rx_result = await self.prescription.write_prescription(
                        message, drug_result_text, patient_context,
                        route.priority_country,
                    )
                    elapsed_rx = int((time.monotonic() - t0_rx) * 1000)
                    agent_outputs["prescription"] = rx_result
                    # Populate prescription_data for frontend
                    brand_opts = rx_result.get("brand_options", [])
                    result.prescription_data = PrescriptionData(
                        prescription=rx_result.get("prescription", ""),
                        brand_options=[
                            BrandOption(
                                ingredient=bo.get("ingredient", ""),
                                brands=bo.get("brands", []),
                                atc=bo.get("atc", ""),
                            )
                            for bo in brand_opts
                        ],
                        country=rx_result.get("country", ""),
                    )
                    result.agents_used.append("prescription")
                    result.agent_timings.append(AgentTiming(
                        agent="prescription", time_ms=elapsed_rx,
                        input_tokens=self.prescription.last_usage["input_tokens"],
                        output_tokens=self.prescription.last_usage["output_tokens"],
                    ))
                    await self._emit(on_status, {
                        "agent": "prescription", "status": "done",
                        "time_ms": elapsed_rx,
                        "tokens": self.prescription.last_usage,
                        "message": "prescription complete",
                    })
                except Exception as e:
                    logging.getLogger("cerebralink.orchestrator").warning(
                        "Prescription agent failed: %s", e,
                    )

        # ── 4. Extract citations ──
        if "research" in agent_outputs and isinstance(agent_outputs["research"], dict):
            for i, g in enumerate(agent_outputs["research"].get("guidelines", []), 1):
                try:
                    result.guidelines_used.append(GuidelineRef(**{
                        k: g[k] for k in ("title", "source", "country", "year", "url") if k in g
                    }))
                    result.citations.append(Citation(
                        index=i, title=g.get("title", ""),
                        source=g.get("source", ""), country=g.get("country", ""),
                        year=g.get("year"), url=g.get("url"),
                        quote=g.get("key_recommendation", ""),
                        importance=g.get("importance"),
                        effect_size=g.get("effect_size"),
                        evidence_level=g.get("evidence_level"),
                    ))
                except Exception:
                    pass

        # ── 5. Fast answer → stream ──
        await self._emit(on_status, {
            "agent": "composer_fast", "status": "running",
            "message": AGENT_LABELS["composer_fast"], "phase": "composing",
        })
        t0 = time.monotonic()
        fast_raw = await self.composer.compose_fast(
            query=message, agent_outputs=agent_outputs,
            patient_context=patient_context, route=route, citations=result.citations,
        )
        t_fast = int((time.monotonic() - t0) * 1000)
        result.fast_answer = self.phi_checker.check_output(fast_raw)
        result.agents_used.append("composer_fast")
        result.agent_timings.append(AgentTiming(
            agent="composer_fast", time_ms=t_fast,
            input_tokens=self.composer.last_usage["input_tokens"],
            output_tokens=self.composer.last_usage["output_tokens"],
        ))
        await self._emit(on_status, {
            "agent": "composer_fast", "status": "done", "time_ms": t_fast,
            "tokens": self.composer.last_usage,
        })
        await self._emit(on_status, {
            "_type": "fast_answer",
            "fast_answer": result.fast_answer,
            "guidelines_used": [g.model_dump() for g in result.guidelines_used],
            "citations": [c.model_dump() for c in result.citations],
            "prescription_data": result.prescription_data.model_dump() if result.prescription_data else None,
        })

        # ── 6. Complete answer + Decision Tree in parallel ──
        parallel_tasks = []

        # Complete answer task
        async def _compose_complete():
            await self._emit(on_status, {
                "agent": "composer_complete", "status": "running",
                "message": AGENT_LABELS["composer_complete"], "phase": "composing",
            })
            t0 = time.monotonic()
            raw = await self.composer.compose_complete(
                query=message, agent_outputs=agent_outputs,
                patient_context=patient_context, route=route, citations=result.citations,
            )
            elapsed = int((time.monotonic() - t0) * 1000)
            result.complete_answer = self.phi_checker.check_output(raw)
            result.agents_used.append("composer_complete")
            result.agent_timings.append(AgentTiming(
                agent="composer_complete", time_ms=elapsed,
                input_tokens=self.composer.last_usage["input_tokens"],
                output_tokens=self.composer.last_usage["output_tokens"],
            ))
            await self._emit(on_status, {
                "agent": "composer_complete", "status": "done", "time_ms": elapsed,
                "tokens": self.composer.last_usage,
            })

        parallel_tasks.append(asyncio.create_task(_compose_complete()))

        # Decision tree task (if needed)
        if route.needs_decision_tree:
            async def _gen_decision_tree():
                await self._emit(on_status, {
                    "agent": "decision_tree", "status": "running",
                    "message": AGENT_LABELS["decision_tree"], "phase": "composing",
                })
                t0 = time.monotonic()
                tree_data = await self.decision_tree_agent.generate(
                    query=message, agent_outputs=agent_outputs,
                    patient_context=patient_context,
                    language=route.language,
                )
                elapsed = int((time.monotonic() - t0) * 1000)
                if tree_data:
                    result.decision_tree = DecisionTree(
                        title=tree_data.get("title", "Clinical Decision Tree"),
                        nodes=[DecisionTreeNode(**n) for n in tree_data.get("nodes", [])],
                        edges=[DecisionTreeEdge(**e) for e in tree_data.get("edges", [])],
                    )
                result.agents_used.append("decision_tree")
                result.agent_timings.append(AgentTiming(
                    agent="decision_tree", time_ms=elapsed,
                    input_tokens=self.decision_tree_agent.last_usage["input_tokens"],
                    output_tokens=self.decision_tree_agent.last_usage["output_tokens"],
                ))
                await self._emit(on_status, {
                    "agent": "decision_tree", "status": "done", "time_ms": elapsed,
                    "tokens": self.decision_tree_agent.last_usage,
                })

            parallel_tasks.append(asyncio.create_task(_gen_decision_tree()))

        # Izlem PDF brief generation (runs in parallel with compose/tree)
        _izlem_log = logging.getLogger("cerebralink.orchestrator.izlem")
        _izlem_log.info(
            "Izlem PDF check: needs_izlem=%s, izlem_data=%s, detected_pid=%s, episodes=%d",
            route.needs_izlem, bool(izlem_data), detected_pid,
            len(izlem_data.get("episodes", [])) if isinstance(izlem_data, dict) else 0,
        )
        if route.needs_izlem and izlem_data and detected_pid:
            async def _gen_izlem_pdf():
                await self._emit(on_status, {
                    "agent": "izlem_pdf", "status": "running",
                    "message": "Generating izlem PDF brief...", "phase": "composing",
                })
                t0 = time.monotonic()
                try:
                    pdf_path = await self.izlem_agent.generate_pdf_brief(
                        protocol_id=detected_pid,
                        izlem_data=izlem_data,
                        language=route.language,
                    )
                    elapsed = int((time.monotonic() - t0) * 1000)
                    import os
                    result.izlem_brief_pdf = os.path.basename(pdf_path)
                    _izlem_log.info("Primary izlem PDF created: %s (%dms)", pdf_path, elapsed)
                    await self._emit(on_status, {
                        "agent": "izlem_pdf", "status": "done",
                        "time_ms": elapsed,
                        "tokens": self.izlem_agent.last_usage,
                        "message": "izlem PDF ready",
                    })
                except Exception as e:
                    _izlem_log.warning(
                        "Izlem PDF generation failed: %s", e, exc_info=True,
                    )
                    await self._emit(on_status, {
                        "agent": "izlem_pdf", "status": "error",
                        "message": f"izlem PDF failed: {e}",
                    })

            parallel_tasks.append(asyncio.create_task(_gen_izlem_pdf()))

        await asyncio.gather(*parallel_tasks, return_exceptions=True)

        # ── 6b. Fallback İzlem PDF from answer text when raw izlem data unavailable ──
        if (route.needs_izlem and detected_pid
                and not result.izlem_brief_pdf
                and result.complete_answer):
            try:
                from src.backend.tools.izlem_pdf import create_izlem_pdf_from_answer
                await self._emit(on_status, {
                    "agent": "izlem_pdf", "status": "running",
                    "message": "Generating izlem PDF from analysis...",
                    "phase": "composing",
                })
                t0 = time.monotonic()
                pdf_path = await create_izlem_pdf_from_answer(
                    protocol_id=detected_pid,
                    answer_text=result.complete_answer,
                    language=route.language,
                )
                elapsed = int((time.monotonic() - t0) * 1000)
                result.izlem_brief_pdf = os.path.basename(pdf_path)
                result.agents_used.append("izlem_pdf")
                result.agent_timings.append(AgentTiming(agent="izlem_pdf", time_ms=elapsed))
                await self._emit(on_status, {
                    "agent": "izlem_pdf", "status": "done",
                    "time_ms": elapsed,
                    "message": "İzlem PDF ready (from analysis)",
                })
            except Exception as e:
                logging.getLogger("cerebralink.orchestrator").warning(
                    "Fallback izlem PDF generation failed: %s", e,
                )

        # ── 7. Trust scoring ──
        await self._emit(on_status, {
            "agent": "trust_scorer", "status": "running",
            "message": AGENT_LABELS["trust_scorer"], "phase": "scoring",
        })
        t0 = time.monotonic()
        trust_result = await self.trust_scorer.score(
            query=message, fast_answer=result.fast_answer,
            complete_answer=result.complete_answer, agent_outputs=agent_outputs,
        )
        timing_trust = self._timing("trust_scorer", t0, self.trust_scorer.last_usage)

        scores = trust_result["scores"]
        reasons = trust_result["reasons"]
        result.trust_scores = TrustScores(**scores)
        result.trust_reasons = TrustReasons(**reasons)
        result.scorer_confidence = trust_result.get("scorer_confidence", 70)
        result.agents_used.append("trust_scorer")
        result.agent_timings.append(timing_trust)
        await self._emit(on_status, {
            "agent": "trust_scorer", "status": "done",
            "time_ms": timing_trust.time_ms, "tokens": self.trust_scorer.last_usage,
        })

        # ── Totals ──
        result.total_time_ms = int((time.monotonic() - t_start) * 1000)
        result.total_input_tokens = sum(t.input_tokens for t in result.agent_timings)
        result.total_output_tokens = sum(t.output_tokens for t in result.agent_timings)

        await shared.put("last_result", {
            "query": message, "agents_used": result.agents_used,
            "trust_avg": sum(scores.values()) // len(scores) if scores else 0,
        })

        return result
