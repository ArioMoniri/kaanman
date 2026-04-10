"""CerebraLink Orchestrator — the agent council coordinator.

Flow:
  1. Router classifies the query -> picks which agents to activate
  2. Store route decision in shared memory
  3. Fan-out: activated agents run in parallel (clinical, research, drug)
  4. Each agent stores its findings in both private + shared memory
  5. Fan-in: Composer merges results into fast + complete answers
  6. Trust Scorer evaluates confidence
  7. PHI Output Checker validates no PHI leaked

Supports SSE streaming of status events via on_status callback.
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
from src.backend.core.memory import AgentMemory, SharedMemory
from src.backend.api.schemas import TrustScores, GuidelineRef, Citation, AgentTiming

StatusCallback = Callable[[dict[str, Any]], Awaitable[None]] | None

AGENT_LABELS = {
    "router": "Classifying query...",
    "clinical": "Deep clinical analysis...",
    "research": "Searching latest guidelines...",
    "drug": "Analyzing drug interactions & dosing...",
    "composer": "Composing response...",
    "trust_scorer": "Evaluating confidence...",
    "phi_check": "Checking for PHI leaks...",
}


class OrchestratorResult:
    """Intermediate container before ChatResponse serialization."""
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

        # 1. Route the query
        await self._emit(on_status, {
            "agent": "router", "status": "running",
            "message": AGENT_LABELS["router"], "phase": "routing",
        })
        t0 = time.monotonic()
        route: RouteDecision = await self.router.classify(message, patient_context)
        t_router = int((time.monotonic() - t0) * 1000)
        usage_router = self.router.last_usage
        result.agents_used.append("router")
        result.agent_timings.append(AgentTiming(
            agent="router", time_ms=t_router,
            input_tokens=usage_router["input_tokens"],
            output_tokens=usage_router["output_tokens"],
        ))
        await self._emit(on_status, {
            "agent": "router", "status": "done", "time_ms": t_router,
            "tokens": usage_router,
            "message": f"Route: {route.category} (urgency {route.urgency}/5)",
        })

        await shared.put("route", {
            "category": route.category,
            "urgency": route.urgency,
            "guideline_countries": route.guideline_countries,
        })

        # 2. Fan-out: run activated agents in parallel
        agent_map: dict[str, tuple[str, Any]] = {}

        if route.needs_clinical:
            agent_map["clinical"] = ("clinical", self.clinical,
                                     self.clinical.analyze, (message, patient_context, history))
        if route.needs_research:
            agent_map["research"] = ("research", self.research,
                                     self.research.search, (message, route.guideline_countries))
        if route.needs_drug:
            agent_map["drug"] = ("drug", self.drug,
                                 self.drug.analyze, (message, patient_context))

        if not agent_map:
            agent_map["clinical"] = ("clinical", self.clinical,
                                     self.clinical.analyze, (message, patient_context, history))

        # Emit running status for all parallel agents
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
            asyncio.create_task(_timed_agent(name, info[1], info[2], info[3]))
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
            except Exception as e:
                result.agents_used.append(f"error")

        # 3. Extract guidelines from research output
        if "research" in agent_outputs and isinstance(agent_outputs["research"], dict):
            for i, g in enumerate(agent_outputs["research"].get("guidelines", []), 1):
                try:
                    result.guidelines_used.append(GuidelineRef(**{
                        k: g[k] for k in ("title", "source", "country", "year", "url")
                        if k in g
                    }))
                    result.citations.append(Citation(
                        index=i,
                        title=g.get("title", ""),
                        source=g.get("source", ""),
                        country=g.get("country", ""),
                        year=g.get("year"),
                        url=g.get("url"),
                        quote=g.get("key_recommendation", ""),
                    ))
                except Exception:
                    pass

        # 4. Compose fast + complete answers
        await self._emit(on_status, {
            "agent": "composer", "status": "running",
            "message": AGENT_LABELS["composer"], "phase": "composing",
        })
        t0 = time.monotonic()
        composed = await self.composer.compose(
            query=message,
            agent_outputs=agent_outputs,
            patient_context=patient_context,
            route=route,
            citations=result.citations,
        )
        t_comp = int((time.monotonic() - t0) * 1000)
        usage_comp = self.composer.last_usage
        result.agents_used.append("composer")
        result.agent_timings.append(AgentTiming(
            agent="composer", time_ms=t_comp,
            input_tokens=usage_comp["input_tokens"],
            output_tokens=usage_comp["output_tokens"],
        ))
        await self._emit(on_status, {
            "agent": "composer", "status": "done", "time_ms": t_comp,
            "tokens": usage_comp,
        })

        # 5. Trust scoring
        await self._emit(on_status, {
            "agent": "trust_scorer", "status": "running",
            "message": AGENT_LABELS["trust_scorer"], "phase": "scoring",
        })
        t0 = time.monotonic()
        scores = await self.trust_scorer.score(
            query=message,
            fast_answer=composed["fast"],
            complete_answer=composed["complete"],
            agent_outputs=agent_outputs,
        )
        t_trust = int((time.monotonic() - t0) * 1000)
        usage_trust = self.trust_scorer.last_usage
        result.trust_scores = TrustScores(**scores)
        result.agents_used.append("trust_scorer")
        result.agent_timings.append(AgentTiming(
            agent="trust_scorer", time_ms=t_trust,
            input_tokens=usage_trust["input_tokens"],
            output_tokens=usage_trust["output_tokens"],
        ))
        await self._emit(on_status, {
            "agent": "trust_scorer", "status": "done", "time_ms": t_trust,
            "tokens": usage_trust,
        })

        # 6. PHI output check
        await self._emit(on_status, {
            "agent": "phi_check", "status": "running",
            "message": AGENT_LABELS["phi_check"], "phase": "safety",
        })
        t0 = time.monotonic()
        result.fast_answer = await self.phi_checker.check_output(composed["fast"])
        result.complete_answer = await self.phi_checker.check_output(composed["complete"])
        t_phi = int((time.monotonic() - t0) * 1000)
        await self._emit(on_status, {
            "agent": "phi_check", "status": "done", "time_ms": t_phi,
        })

        # Totals
        result.total_time_ms = int((time.monotonic() - t_start) * 1000)
        result.total_input_tokens = sum(t.input_tokens for t in result.agent_timings)
        result.total_output_tokens = sum(t.output_tokens for t in result.agent_timings)

        # 7. Store final result in shared memory
        await shared.put("last_result", {
            "query": message,
            "agents_used": result.agents_used,
            "trust_avg": sum(scores.values()) // len(scores) if scores else 0,
        })

        return result
