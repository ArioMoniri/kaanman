"""Pydantic models for the CerebraLink API."""

from __future__ import annotations

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None


class GuidelineRef(BaseModel):
    title: str
    source: str
    country: str
    year: int | None = None
    url: str | None = None


class Citation(BaseModel):
    index: int
    title: str
    source: str
    country: str
    year: int | None = None
    url: str | None = None
    quote: str = ""
    importance: str | None = None        # "high" | "medium" | "low"
    effect_size: str | None = None       # "large" | "moderate" | "small" | "none"
    evidence_level: str | None = None    # e.g. "Level A", "Grade I", "1a"


class AgentTiming(BaseModel):
    agent: str
    time_ms: int
    input_tokens: int = 0
    output_tokens: int = 0
    status: str = "done"


class TrustScores(BaseModel):
    evidence_quality: int = Field(ge=0, le=100)
    guideline_alignment: int = Field(ge=0, le=100)
    clinical_relevance: int = Field(ge=0, le=100)
    safety_check: int = Field(ge=0, le=100)
    completeness: int = Field(ge=0, le=100)
    source_recency: int = Field(ge=0, le=100)


class TrustReasons(BaseModel):
    evidence_quality: str = ""
    guideline_alignment: str = ""
    clinical_relevance: str = ""
    safety_check: str = ""
    completeness: str = ""
    source_recency: str = ""


class DecisionTreeNode(BaseModel):
    id: str
    type: str = "default"
    data: dict = {}
    position: dict = {}


class DecisionTreeEdge(BaseModel):
    id: str
    source: str
    target: str
    label: str = ""


class DecisionTree(BaseModel):
    title: str = ""
    nodes: list[DecisionTreeNode] = []
    edges: list[DecisionTreeEdge] = []


class ChatResponse(BaseModel):
    session_id: str
    fast_answer: str
    complete_answer: str
    trust_scores: TrustScores
    trust_reasons: TrustReasons = TrustReasons()
    scorer_confidence: int = 70
    guidelines_used: list[GuidelineRef] = []
    citations: list[Citation] = []
    agents_used: list[str] = []
    agent_timings: list[AgentTiming] = []
    total_time_ms: int = 0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    decision_tree: DecisionTree | None = None
    language: str = "en"
    priority_country: str = ""
    patient_context: dict | None = None
    izlem_brief_pdf: str | None = None  # Path to generated izlem PDF brief


class PatientIngestRequest(BaseModel):
    cookies_json: str


class PatientIngestResponse(BaseModel):
    success: bool
    session_id: str
    patient_summary: str = ""
    error: str | None = None


class SessionInfoResponse(BaseModel):
    session_id: str
    has_patient: bool
    message_count: int
    patient_summary: str | None = None
