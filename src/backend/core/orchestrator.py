"""CerebraLink Orchestrator — the agent council coordinator.

Flow:
  1. Guardrail: Router classifies query (medical / greeting / off-topic)
  2. If non-medical → return direct response, skip pipeline
  3. If protocol ID detected → auto-fetch patient data from Cerebral Plus
  4. Fan-out: activated agents run in parallel
  5. Compose FAST answer → stream immediately
  6. Compose COMPLETE answer
  7. Trust scoring
  8. PHI regex check (no LLM — preserves formatting)

Supports SSE streaming via on_status callback.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Callable, Awaitable

from src.backend.agents.router import RouterAgent, RouteDecision
from src.backend.agents.clinical import ClinicalAgent
from src.backend.agents.research import ResearchAgent
from src.backend.agents.drug import DrugAgent
from src.backend.agents.composer import ComposerAgent
from src.backend.agents.trust import TrustScorerAgent
from src.backend.agents.phi_masker import PhiMasker
from src.backend.core.memory import AgentMemory, SharedMemory, SessionMemory
from src.backend.api.schemas import TrustScores, GuidelineRef, Citation, AgentTiming
from src.backend.tools.cerebral import auto_fetch_patient

StatusCallback = Callable[[dict[str, Any]], Awaitable[None]] | None

AGENT_LABELS = {
    "router": "Classifying query...",
    "patient_fetch": "Fetching patient data...",
    "clinical": "Deep clinical analysis...",
    "research": "Searching latest guidelines...",
    "drug": "Analyzing drug interactions & dosing...",
    "composer_fast": "Composing fast answer...",
    "composer_complete": "Composing complete analysis...",
    "trust_scorer": "Evaluating confidence...",
    "phi_check": "Safety check...",
}


class OrchestratorResult:
    def __init__(self):
        self.fast_answer: str = ""
        self.complete_answer: str = ""
        self.trust_scores = TrustScores(
            evidence_quality=50, guideline_alignment=50,
            clinical_relevance=50, safety_check=50,
            completeness=50, source_recency=50,
        )
        self.guidelines_used: list[GuidelineRef] = []
        self.citations: list[Citation] = []
        self.agents_used: list[str] = []
        self.agent_timings: list[AgentTiming] = []
        self.total_time_ms: int = 0
        self.total_input_tokens: int = 0
        self.total_output_tokens: int = 0

    def model_dump(self) -> dict:
        return {
            "fast_answer": self.fast_answer,
            "complete_answer": self.complete_answer,
            "trust_scores": self.trust_scores,
            "guidelines_used": self.guidelines_used,
            "citations": self.citations,
            "agents_used": self.agents_used,
            "agent_timings": [t.model_dump() for t in self.agent_timings],
            "total_time_ms": self.total_time_ms,
            "total_input_tokens": self.total_input_tokens,
            "total_output_tokens": self.total_output_tokens,
        }


class Orchestrator:
    def __init__(self):
        self.router = RouterAgent()
        self.clinical = ClinicalAgent()
        self.research = ResearchAgent()
        self.drug = DrugAgent()
        self.composer = ComposerAgent()
        self.trust_scorer = TrustScorerAgent()
        self.phi_checker = PhiMasker()

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
        await self._emit(on_status, {
            "agent": "router", "status": "done", "time_ms": timing_router.time_ms,
            "tokens": self.router.last_usage,
            "message": f"Route: {route.category} (urgency {route.urgency}/5)",
        })

        # ── Non-medical queries: respond directly ──
        if not route.is_medical:
            result.fast_answer = route.direct_response
            result.complete_answer = route.direct_response
            result.total_time_ms = int((time.monotonic() - t_start) * 1000)
            result.total_input_tokens = timing_router.input_tokens
            result.total_output_tokens = timing_router.output_tokens
            await self._emit(on_status, {
                "_type": "fast_answer",
                "fast_answer": result.fast_answer,
                "guidelines_used": [],
                "citations": [],
            })
            return result

        await shared.put("route", {
            "category": route.category, "urgency": route.urgency,
            "guideline_countries": route.guideline_countries,
        })

        # ── 2. Auto-fetch patient if protocol ID detected ──
        if route.detected_protocol_id and not patient_context:
            await self._emit(on_status, {
                "agent": "patient_fetch", "status": "running",
                "message": f"Fetching patient {route.detected_protocol_id}...",
                "phase": "patient_fetch",
            })
            t0 = time.monotonic()
            try:
                raw_patient = await auto_fetch_patient(route.detected_protocol_id)
                masked = await self.phi_checker.mask_patient_record(raw_patient)
                patient_context = masked.get("masked_record", raw_patient)

                # Store in session memory
                mem = SessionMemory(session_id)
                await mem.set_patient_context(patient_context)

                t_fetch = int((time.monotonic() - t0) * 1000)
                result.agents_used.append("patient_fetch")
                result.agent_timings.append(AgentTiming(
                    agent="patient_fetch", time_ms=t_fetch,
                ))
                await self._emit(on_status, {
                    "agent": "patient_fetch", "status": "done",
                    "time_ms": t_fetch,
                    "message": f"Patient data loaded & PHI-masked",
                })
            except Exception as e:
                t_fetch = int((time.monotonic() - t0) * 1000)
                await self._emit(on_status, {
                    "agent": "patient_fetch", "status": "error",
                    "time_ms": t_fetch,
                    "message": f"Patient fetch failed: {e}",
                })
                # Continue without patient context

        # ── 3. Fan-out: parallel agents ──
        agent_map: dict[str, tuple] = {}

        if route.needs_clinical:
            agent_map["clinical"] = (self.clinical, self.clinical.analyze, (message, patient_context, history))
        if route.needs_research:
            agent_map["research"] = (self.research, self.research.search, (message, route.guideline_countries))
        if route.needs_drug:
            agent_map["drug"] = (self.drug, self.drug.analyze, (message, patient_context))

        if not agent_map:
            agent_map["clinical"] = (self.clinical, self.clinical.analyze, (message, patient_context, history))

        for name in agent_map:
            await self._emit(on_status, {
                "agent": name, "status": "running",
                "message": AGENT_LABELS.get(name, f"{name} working..."),
                "phase": "council",
            })

        async def _timed_agent(name, agent_instance, fn, args):
            t0 = time.monotonic()
            agent_mem = AgentMemory(session_id, name)
            output = await fn(*args)
            elapsed = int((time.monotonic() - t0) * 1000)
            usage = agent_instance.last_usage

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

        tasks = [
            asyncio.create_task(_timed_agent(name, info[0], info[1], info[2]))
            for name, info in agent_map.items()
        ]

        agent_outputs: dict[str, Any] = {}
        for coro in asyncio.as_completed(tasks):
            try:
                name, output, elapsed, usage = await coro
                agent_outputs[name] = output
                result.agents_used.append(name)
                result.agent_timings.append(AgentTiming(
                    agent=name, time_ms=elapsed,
                    input_tokens=usage["input_tokens"],
                    output_tokens=usage["output_tokens"],
                ))
            except Exception:
                pass

        # ── 4. Extract citations from research output ──
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
                    ))
                except Exception:
                    pass

        # ── 5. Compose FAST answer → stream immediately ──
        await self._emit(on_status, {
            "agent": "composer_fast", "status": "running",
            "message": AGENT_LABELS["composer_fast"], "phase": "composing",
        })
        t0 = time.monotonic()
        fast_raw = await self.composer.compose_fast(
            query=message, agent_outputs=agent_outputs,
            patient_context=patient_context, route=route,
            citations=result.citations,
        )
        t_fast = int((time.monotonic() - t0) * 1000)
        usage_fast = self.composer.last_usage
        result.fast_answer = self.phi_checker.check_output(fast_raw)
        result.agents_used.append("composer_fast")
        result.agent_timings.append(AgentTiming(
            agent="composer_fast", time_ms=t_fast,
            input_tokens=usage_fast["input_tokens"],
            output_tokens=usage_fast["output_tokens"],
        ))

        # Stream the fast answer to the client immediately
        await self._emit(on_status, {
            "agent": "composer_fast", "status": "done", "time_ms": t_fast,
            "tokens": usage_fast,
        })
        await self._emit(on_status, {
            "_type": "fast_answer",
            "fast_answer": result.fast_answer,
            "guidelines_used": [g.model_dump() for g in result.guidelines_used],
            "citations": [c.model_dump() for c in result.citations],
        })

        # ── 6. Compose COMPLETE answer ──
        await self._emit(on_status, {
            "agent": "composer_complete", "status": "running",
            "message": AGENT_LABELS["composer_complete"], "phase": "composing",
        })
        t0 = time.monotonic()
        complete_raw = await self.composer.compose_complete(
            query=message, agent_outputs=agent_outputs,
            patient_context=patient_context, route=route,
            citations=result.citations,
        )
        t_comp = int((time.monotonic() - t0) * 1000)
        usage_comp = self.composer.last_usage
        result.complete_answer = self.phi_checker.check_output(complete_raw)
        result.agents_used.append("composer_complete")
        result.agent_timings.append(AgentTiming(
            agent="composer_complete", time_ms=t_comp,
            input_tokens=usage_comp["input_tokens"],
            output_tokens=usage_comp["output_tokens"],
        ))
        await self._emit(on_status, {
            "agent": "composer_complete", "status": "done", "time_ms": t_comp,
            "tokens": usage_comp,
        })

        # ── 7. Trust scoring ──
        await self._emit(on_status, {
            "agent": "trust_scorer", "status": "running",
            "message": AGENT_LABELS["trust_scorer"], "phase": "scoring",
        })
        t0 = time.monotonic()
        scores = await self.trust_scorer.score(
            query=message, fast_answer=result.fast_answer,
            complete_answer=result.complete_answer,
            agent_outputs=agent_outputs,
        )
        timing_trust = self._timing("trust_scorer", t0, self.trust_scorer.last_usage)
        result.trust_scores = TrustScores(**scores)
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
