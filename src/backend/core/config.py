"""CerebraLink configuration — single source of truth for all settings."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from dotenv import load_dotenv

load_dotenv()


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


@dataclass(frozen=True)
class ModelConfig:
    router: str = field(default_factory=lambda: _env("MODEL_ROUTER", "claude-haiku-4-5-20251001"))
    phi_masker: str = field(default_factory=lambda: _env("MODEL_PHI_MASKER", "claude-haiku-4-5-20251001"))
    clinical: str = field(default_factory=lambda: _env("MODEL_CLINICAL", "claude-opus-4-6"))
    research: str = field(default_factory=lambda: _env("MODEL_RESEARCH", "claude-sonnet-4-6"))
    drug: str = field(default_factory=lambda: _env("MODEL_DRUG", "claude-sonnet-4-6"))
    composer: str = field(default_factory=lambda: _env("MODEL_COMPOSER", "claude-sonnet-4-6"))
    trust: str = field(default_factory=lambda: _env("MODEL_TRUST", "claude-haiku-4-5-20251001"))


@dataclass(frozen=True)
class Settings:
    anthropic_api_key: str = field(default_factory=lambda: _env("ANTHROPIC_API_KEY"))
    exa_api_key: str = field(default_factory=lambda: _env("EXA_API_KEY"))
    redis_url: str = field(default_factory=lambda: _env("REDIS_URL", "redis://localhost:6379/0"))
    medical_mcp_url: str = field(default_factory=lambda: _env("MEDICAL_MCP_URL", "http://localhost:3001"))
    models: ModelConfig = field(default_factory=ModelConfig)
    max_context_tokens: int = 100_000
    cerebral_host: str = field(default_factory=lambda: _env("CEREBRAL_HOST", "cerebralplustr.acibadem.com.tr"))


settings = Settings()
