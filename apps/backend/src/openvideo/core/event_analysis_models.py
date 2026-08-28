"""焦点选区与局部事件分析的持久化领域契约。"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from openvideo.core.analysis_models import AnalysisDepth
from openvideo.core.media_models import MediaSegment
from openvideo.core.transcription_models import TranscriptSegment


class FocusSelection(BaseModel):
    """每个素材唯一的通用 AI 关注范围，不表达正式内容标记。"""

    model_config = ConfigDict(extra="forbid")

    selection_id: str
    asset_id: str
    in_seconds: float | None = Field(default=None, ge=0)
    out_seconds: float | None = Field(default=None, ge=0)
    revision: int = Field(default=1, ge=1)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @property
    def is_complete(self) -> bool:
        return (
            self.in_seconds is not None
            and self.out_seconds is not None
            and self.in_seconds < self.out_seconds
        )


class FocusSelectionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    in_seconds: float | None = Field(default=None, ge=0)
    out_seconds: float | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def require_endpoint(self) -> "FocusSelectionUpdate":
        if not self.model_fields_set:
            raise ValueError("至少需要提交一个焦点选区端点")
        return self


class MarkerEventAnalysisTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: Literal["marker"] = "marker"
    marker_id: str
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(gt=0)

    @model_validator(mode="after")
    def validate_range(self) -> "MarkerEventAnalysisTarget":
        if self.end_seconds <= self.start_seconds:
            raise ValueError("事件分析结束时间必须晚于开始时间")
        return self


class FocusSelectionEventAnalysisTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: Literal["focus_selection"] = "focus_selection"
    selection_id: str
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(gt=0)

    @model_validator(mode="after")
    def validate_range(self) -> "FocusSelectionEventAnalysisTarget":
        if self.end_seconds <= self.start_seconds:
            raise ValueError("事件分析结束时间必须晚于开始时间")
        return self


EventAnalysisTarget = Annotated[
    MarkerEventAnalysisTarget | FocusSelectionEventAnalysisTarget,
    Field(discriminator="source"),
]


class EventAnalysisEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(gt=0)
    text: str = Field(min_length=1, max_length=20_000)
    source: Literal["transcript", "timeline", "visual", "ocr"]

    @model_validator(mode="after")
    def validate_range(self) -> "EventAnalysisEvidence":
        if self.end_seconds <= self.start_seconds:
            raise ValueError("证据结束时间必须晚于开始时间")
        return self


class EventAnalysisSourceSummary(BaseModel):
    """保存可比较的输入摘要，使来源更新能精确使历史结果过期。"""

    model_config = ConfigDict(extra="forbid")

    transcript_digest: str
    target_digest: str
    timeline_digest: str


class EventAnalysisStatus(StrEnum):
    VALID = "valid"
    STALE = "stale"


class EventAnalysis(BaseModel):
    """局部理解结果保持结构化，以便展示、筛选和正式总结复用。"""

    model_config = ConfigDict(extra="forbid")

    event_analysis_id: str
    asset_id: str
    target: EventAnalysisTarget
    title: str = Field(min_length=1, max_length=300)
    conclusion: str = Field(min_length=1, max_length=20_000)
    key_points: list[str] = Field(default_factory=list, max_length=100)
    evidence: list[EventAnalysisEvidence] = Field(default_factory=list, max_length=200)
    preset_id: str
    preset_version: int = Field(ge=1)
    depth: AnalysisDepth
    user_input: str | None = Field(default=None, max_length=20_000)
    ai_model_id: str
    source_summary: EventAnalysisSourceSummary
    status: EventAnalysisStatus = EventAnalysisStatus.VALID
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class EventAnalysisJobStage(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETE = "complete"
    FAILED = "failed"


TERMINAL_EVENT_ANALYSIS_JOB_STAGES = {
    EventAnalysisJobStage.COMPLETE,
    EventAnalysisJobStage.FAILED,
}


class EventAnalysisJob(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: str
    asset_id: str
    targets: list[EventAnalysisTarget] = Field(min_length=1, max_length=100)
    preset_id: str
    preset_version: int = Field(ge=1)
    depth: AnalysisDepth
    user_input: str | None = Field(default=None, max_length=20_000)
    ai_model_id: str
    stage: EventAnalysisJobStage = EventAnalysisJobStage.PENDING
    progress_percent: float = Field(default=0, ge=0, le=100)
    message: str = "等待开始"
    result_ids: list[str] = Field(default_factory=list)
    error_message: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class EventAnalysisJobCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    marker_ids: list[str] = Field(default_factory=list, max_length=100)
    use_focus_selection: bool = False
    preset_id: str = Field(min_length=1, max_length=100)
    preset_version: int = Field(default=1, ge=1)
    depth: AnalysisDepth = AnalysisDepth.BALANCED
    user_input: str | None = Field(default=None, max_length=20_000)
    ai_model_id: str

    @model_validator(mode="after")
    def validate_targets(self) -> "EventAnalysisJobCreate":
        if bool(self.marker_ids) == self.use_focus_selection:
            raise ValueError("必须选择标记目标或当前焦点选区，且两者不能混用")
        if len(self.marker_ids) != len(set(self.marker_ids)):
            raise ValueError("事件分析目标不能重复")
        return self


class EventAnalysesFile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    format_version: int = 1
    asset_id: str
    analyses: list[EventAnalysis] = Field(default_factory=list)


def transcript_evidence_for_target(
    target: EventAnalysisTarget,
    segments: list[TranscriptSegment],
) -> list[TranscriptSegment]:
    return [
        segment
        for segment in segments
        if segment.end_seconds > target.start_seconds
        and segment.start_seconds < target.end_seconds
    ]


def timeline_evidence_for_target(
    target: EventAnalysisTarget,
    segments: list[MediaSegment],
) -> list[MediaSegment]:
    return [
        segment
        for segment in segments
        if segment.end_seconds > target.start_seconds
        and segment.start_seconds < target.end_seconds
    ]


def build_event_analysis_source_summary(
    target: EventAnalysisTarget,
    transcript_evidence: list[TranscriptSegment],
    timeline_evidence: list[MediaSegment],
) -> EventAnalysisSourceSummary:
    return EventAnalysisSourceSummary(
        transcript_digest=_event_source_digest(
            [item.model_dump(mode="json") for item in transcript_evidence]
        ),
        target_digest=_event_source_digest(target.model_dump(mode="json")),
        timeline_digest=_event_source_digest(
            [item.model_dump(mode="json") for item in timeline_evidence]
        ),
    )


def _event_source_digest(value: object) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
