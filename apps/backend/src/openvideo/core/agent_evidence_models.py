"""Agent 回答所使用的可核验证据与确定性结果。"""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class AgentEvidenceSource(StrEnum):
    TRANSCRIPT = "transcript"
    ANALYSIS = "analysis"
    VISUAL = "visual"
    OCR = "ocr"


class AgentEvidenceConfidence(StrEnum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class AgentAnswerStatus(StrEnum):
    FINAL = "final"
    PROVISIONAL = "provisional"
    INSUFFICIENT = "insufficient"


class AgentEvidenceItem(BaseModel):
    evidence_id: str = Field(pattern=r"^evidence-[0-9a-f]{32}$")
    citation_key: str = Field(pattern=r"^E[1-9][0-9]*$")
    source_type: AgentEvidenceSource
    source_version: str = Field(pattern=r"^[0-9a-f]{64}$")
    asset_id: str = Field(min_length=1)
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(gt=0)
    title: str | None = None
    excerpt: str = Field(min_length=1)
    relation: Literal["supports", "conflicts"] = "supports"
    retrieval_relation: (
        Literal["direct", "neighbor", "overview", "corroborated"] | None
    ) = None
    relevance_score: float = Field(ge=0, le=1)
    match_reasons: list[str] = Field(default_factory=list)
    supporting_source_types: list[AgentEvidenceSource] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_time_range(self) -> "AgentEvidenceItem":
        if self.end_seconds <= self.start_seconds:
            raise ValueError("证据结束时间必须晚于开始时间")
        return self


class AgentEvidenceConflict(BaseModel):
    evidence_ids: list[str] = Field(min_length=2)
    reason: str = Field(min_length=1)


class AgentEvidenceCoverage(BaseModel):
    temporal: float = Field(ge=0, le=1)
    source_types: list[AgentEvidenceSource] = Field(default_factory=list)


class AgentEvidenceBundle(BaseModel):
    query: str | None = None
    start_seconds: float | None = Field(default=None, ge=0)
    end_seconds: float | None = Field(default=None, gt=0)
    items: list[AgentEvidenceItem] = Field(default_factory=list)
    conflicts: list[AgentEvidenceConflict] = Field(default_factory=list)
    coverage: AgentEvidenceCoverage


class AgentEvidenceSearchResult(BaseModel):
    confidence: AgentEvidenceConfidence
    confidence_reasons: list[str] = Field(default_factory=list)
    answer_status: AgentAnswerStatus
    evidence_bundle: AgentEvidenceBundle
    answer_instruction: str = Field(min_length=1)
