"""CerebraLink Orchestrator — the agent council coordinator.

Flow:
  1. Router classifies the query → picks which agents to activate
  2. Fan-out: activated agents run in parallel (clinical, research, drug)
  3. Fan-in: Composer merges results into fast + complete answers
  4. Trust Scorer evaluates confidence
  5. PHI Output Checker validates no PHI leaked
"""

from __future__ import annotations

import asyncio
from typing import Any

from src.backend.agents.router import RouterAgent, RouteDecision
from src.backend.agents.clinical import ClinicalAgent
from src.backend.agents.research import ResearchAgent
from src.backend.agents.drug import DrugAgent
from src.backend.agents.composer import ComposerAgent
from src.backend.agents.trust import TrustScorerAgent
from src.backend.agents.phi_masker import PhiMasker
from src.backend.api.schemas import ChatResponse, TrustScores, GuidelineRef


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
        self.agents_used: list[str] = []

    def model_dump(self) -> dict:
        return {
            "fast_answer": self.fast_answer,
            "complete_answer": self.complete_answer,
            "trust_scores": self.trust_scores,
            "guidelines_used": self.guidelines_used,
            "agents_used": self.agents_used,
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

    async def run(
        self,
        message: str,
        patient_context: dict[str, Any] | None,
        history: list[dict],
        session_id: str,
    ) -> OrchestratorResult:
        result = OrchestratorResult()

        # 1. Route the query
        route: RouteDecision = await self.router.classify(message, patient_context)
        result.agents_used.append("router")

        # 2. Fan-out: run activated agents in parallel
        tasks: dict[str, asyncio.Task] = {}

        if route.needs_clinical:
            tasks["clinical"] = asyncio.create_task(
                self.clinical.analyze(message, patient_context, history)
            )
        if route.needs_research:
            tasks["research"] = asyncio.create_task(
                self.research.search(message, route.guideline_countries)
            )
        if route.needs_drug:
            tasks["drug"] = asyncio.create_task(
                self.drug.analyze(message, patient_context)
            )

        # Always run at least clinical if nothing was selected
        if not tasks:
            tasks["clinical"] = asyncio.create_task(
                self.clinical.analyze(message, patient_context, history)
            )

        agent_outputs: dict[str, Any] = {}
        for name, task in tasks.items():
            try:
                agent_outputs[name] = await task
                result.agents_used.append(name)
            except Exception as e:
                agent_outputs[name] = {"error": str(e)}
                result.agents_used.append(f"{name}(error)")

        # 3. Extract guidelines from research output
        if "research" in agent_outputs and isinstance(agent_outputs["research"], dict):
            for g in agent_outputs["research"].get("guidelines", []):
                result.guidelines_used.append(GuidelineRef(**g))

        # 4. Compose fast + complete answers
        composed = await self.composer.compose(
            query=message,
            agent_outputs=agent_outputs,
            patient_context=patient_context,
            route=route,
        )
        result.agents_used.append("composer")

        # 5. Trust scoring
        scores = await self.trust_scorer.score(
            query=message,
            fast_answer=composed["fast"],
            complete_answer=composed["complete"],
            agent_outputs=agent_outputs,
        )
        result.trust_scores = TrustScores(**scores)
        result.agents_used.append("trust_scorer")

        # 6. PHI output check — strip any leaked PHI
        result.fast_answer = await self.phi_checker.check_output(composed["fast"])
        result.complete_answer = await self.phi_checker.check_output(composed["complete"])

        return result
