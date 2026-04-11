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
import time
from typing import Any, Callable, Awaitable

from src.backend.agents.router import RouterAgent, RouteDecision
from src.backend.agents.clinical import ClinicalAgent
from src.backend.agents.research import ResearchAgent
from src.backend.agents.drug import DrugAgent
from src.backend.agents.composer import ComposerAgent
from src.backend.agents.trust import TrustScorerAgent
from src.backend.agents.decision_tree import DecisionTreeAgent
from src.backend.agents.phi_masker import PhiMasker
from src.backend.core.memory import AgentMemory, SharedMemory, SessionMemory
from src.backend.api.schemas import (
    TrustScores, TrustReasons, GuidelineRef, Citation, AgentTiming,
    DecisionTree, DecisionTreeNode, DecisionTreeEdge,
)
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
    "decision_tree": "Generating decision tree...",
    "trust_scorer": "Evaluating confidence...",
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
        }


class Orchestrator:
    def __init__(self):
        self.router = RouterAgent()
        self.clinical = ClinicalAgent()
        self.research = ResearchAgent()
        self.drug = DrugAgent()
        self.composer = ComposerAgent()
        self.trust_scorer = TrustScorerAgent()
        self.decision_tree_agent = DecisionTreeAgent()
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
                mem = SessionMemory(session_id)
                await mem.set_patient_context(patient_context)
                t_fetch = int((time.monotonic() - t0) * 1000)
                result.agents_used.append("patient_fetch")
                result.agent_timings.append(AgentTiming(agent="patient_fetch", time_ms=t_fetch))
                result.patient_context = patient_context
                await self._emit(on_status, {
                    "agent": "patient_fetch", "status": "done",
                    "time_ms": t_fetch, "message": "Patient data loaded & PHI-masked",
                })
            except FileNotFoundError as e:
                t_fetch = int((time.monotonic() - t0) * 1000)
                await self._emit(on_status, {
                    "agent": "patient_fetch", "status": "error",
                    "time_ms": t_fetch,
                    "message": f"Patient fetch failed — missing file: {e}",
                })
            except Exception as e:
                t_fetch = int((time.monotonic() - t0) * 1000)
                import traceback
                tb = traceback.format_exc()
                await self._emit(on_status, {
                    "agent": "patient_fetch", "status": "error",
                    "time_ms": t_fetch,
                    "message": f"Patient fetch failed: {type(e).__name__}: {e}",
                })
                import logging
                logging.getLogger("cerebralink.orchestrator").error(
                    "Patient fetch error for protocol %s:\n%s", route.detected_protocol_id, tb
                )

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

        await asyncio.gather(*parallel_tasks, return_exceptions=True)

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
