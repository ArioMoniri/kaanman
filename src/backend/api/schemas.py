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


class TrustScores(BaseModel):
    evidence_quality: int = Field(ge=0, le=100)
    guideline_alignment: int = Field(ge=0, le=100)
    clinical_relevance: int = Field(ge=0, le=100)
    safety_check: int = Field(ge=0, le=100)
    completeness: int = Field(ge=0, le=100)
    source_recency: int = Field(ge=0, le=100)


class ChatResponse(BaseModel):
    session_id: str
    fast_answer: str
    complete_answer: str
    trust_scores: TrustScores
    guidelines_used: list[GuidelineRef] = []
    agents_used: list[str] = []


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
