from __future__ import annotations

import difflib
import hashlib
import json
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from openvideo.agent_runtime import AgentRuntimeError
from openvideo.core.agent_runtime_models import (
    AgentArtifact,
    AgentEventType,
    AgentRun,
    AgentSession,
)
from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.identifiers import uuid7
from openvideo.core.media_models import MediaMarker, MediaSegment
from openvideo.core.summary_models import SummaryDocumentCreate, SummaryMediaType

if TYPE_CHECKING:
    from openvideo.agent_service import AgentService


class MarkerChangeOperation(StrEnum):
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"
    MERGE = "merge"


class EvidenceSearchInput(BaseModel):
    query: str | None = Field(default=None, max_length=500)
    start_seconds: float | None = Field(default=None, ge=0)
    end_seconds: float | None = Field(default=None, ge=0)
    limit: int = Field(default=12, ge=1, le=30)

    @model_validator(mode="after")
    def validate_range(self) -> "EvidenceSearchInput":
        if (
            self.start_seconds is not None
            and self.end_seconds is not None
            and self.end_seconds <= self.start_seconds
        ):
            raise ValueError("结束时间必须晚于开始时间")
        return self


class ReadMarkersInput(BaseModel):
    pass


class InspectFramesInput(BaseModel):
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(gt=0)
    question: str = Field(min_length=1, max_length=1_000)

    @model_validator(mode="after")
    def validate_range(self) -> "InspectFramesInput":
        if self.end_seconds <= self.start_seconds:
            raise ValueError("结束时间必须晚于开始时间")
        return self


class ProposedMarkerChangeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation: MarkerChangeOperation
    marker_ids: list[str] = Field(default_factory=list, max_length=100)
    start_seconds: float | None = Field(default=None, ge=0)
    end_seconds: float | None = Field(default=None, ge=0)
    reason: str = Field(min_length=1, max_length=2_000)
    evidence: list[dict[str, Any]] = Field(default_factory=list, max_length=20)


class ProposeMarkerChangesInput(BaseModel):
    changes: list[ProposedMarkerChangeInput] = Field(min_length=1, max_length=100)


class ReadSummaryDocumentInput(BaseModel):
    document_id: str


class ProposeSummaryEditInput(BaseModel):
    document_id: str
    expected_revision: int = Field(ge=1)
    proposed_markdown: str
    explanation: str = Field(min_length=1, max_length=4_000)
    suggested_subdocuments: list[SummaryDocumentCreate] = Field(default_factory=list)


class ProposeSummaryMediaInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str
    expected_revision: int = Field(ge=1)
    media_type: SummaryMediaType
    start_seconds: float = Field(ge=0)
    end_seconds: float | None = Field(default=None, ge=0)
    insert_after: str = Field(min_length=1, max_length=2_000)
    caption: str = Field(min_length=1, max_length=500)
    reason: str = Field(min_length=1, max_length=2_000)
    confidence: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def validate_media_range(self) -> "ProposeSummaryMediaInput":
        if self.media_type == SummaryMediaType.IMAGE and self.end_seconds is not None:
            raise ValueError("静态图片不能设置结束时间")
        if self.media_type == SummaryMediaType.GIF and self.end_seconds is None:
            raise ValueError("GIF 必须设置结束时间")
        if self.end_seconds is not None and self.end_seconds <= self.start_seconds:
            raise ValueError("结束时间必须晚于开始时间")
        return self


class CorrectTranscriptInput(BaseModel):
    segment_indices: list[int] | None = None
    execution_mode: str = Field(
        default="automatic", pattern=r"^(automatic|chunked|compressed)$"
    )


@dataclass
class RunEvidenceState:
    markers_read: bool = False
    evidence_read: bool = False
    frames_inspected: bool = False
    summary_read: bool = False
    inspected_frame_times: list[float] = field(default_factory=list)
    inspected_frame_ranges: list[tuple[float, float]] = field(default_factory=list)


@dataclass
class AgentRunContext:
    service: AgentService
    session: AgentSession
    run: AgentRun
    model: AiModelConfiguration
    task_input: dict[str, Any]
    evidence: RunEvidenceState = field(default_factory=RunEvidenceState)

    def create_artifact(
        self, result_type: str, payload: dict[str, Any]
    ) -> AgentArtifact:
        artifact = AgentArtifact(
            artifact_id=f"artifact-{uuid7().hex}",
            run_id=self.run.run_id,
            session_id=self.session.session_id,
            agent_id=self.session.agent_id,
            asset_id=self.session.asset_id,
            result_type=result_type,
            payload=payload,
        )
        self.service.library.save_agent_artifact(artifact)
        self.service.store.append(
            self.session.session_id,
            self.run.run_id,
            AgentEventType.ARTIFACT_CREATED,
            {"artifact": artifact.model_dump(mode="json")},
        )
        return artifact


def ranges_intersect(
    start: float,
    end: float,
    range_start: float | None,
    range_end: float | None,
) -> bool:
    return not (
        (range_start is not None and end < range_start)
        or (range_end is not None and start > range_end)
    )


def build_proposed_marker(
    asset_id: str,
    requested: ProposedMarkerChangeInput,
    before: list[MediaMarker],
) -> MediaMarker | None:
    if requested.operation == MarkerChangeOperation.DELETE:
        return None
    if requested.start_seconds is None:
        raise AgentRuntimeError("新增、修改或合并建议必须提供开始时间")
    marker_id = (
        before[0].marker_id
        if requested.operation == MarkerChangeOperation.UPDATE
        else f"marker-{uuid7().hex}"
    )
    if requested.operation == MarkerChangeOperation.UPDATE:
        importance = before[0].importance
    elif requested.operation == MarkerChangeOperation.MERGE:
        importance = max(marker.importance for marker in before)
    else:
        importance = 0
    return MediaMarker(
        marker_id=marker_id,
        asset_id=asset_id,
        start_seconds=requested.start_seconds,
        end_seconds=requested.end_seconds,
        importance=importance,
    )


def validate_marker_bounds(marker: MediaMarker, duration: float | None) -> None:
    if duration is not None and (
        marker.start_seconds > duration
        or (marker.end_seconds is not None and marker.end_seconds > duration)
    ):
        raise AgentRuntimeError("标记范围超出视频时长")


def marker_digest(markers: list[MediaMarker]) -> str:
    payload = [
        marker.model_dump(mode="json")
        for marker in sorted(markers, key=lambda item: item.marker_id)
    ]
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()


def transcript_digest(transcript: Any) -> str:
    payload = [
        {
            "start_seconds": segment.start_seconds,
            "end_seconds": segment.end_seconds,
            "text": segment.text,
        }
        for segment in transcript.segments
    ]
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()


def rewrite_segment_references(
    segments: list[MediaSegment], source_ids: set[str], replacement_id: str | None
) -> list[MediaSegment]:
    rewritten: list[MediaSegment] = []
    for segment in segments:
        original = segment.marker_ids
        marker_ids = [item for item in original if item not in source_ids]
        if replacement_id and any(item in source_ids for item in original):
            marker_ids.append(replacement_id)
        rewritten.append(
            segment.model_copy(update={"marker_ids": list(dict.fromkeys(marker_ids))})
        )
    return rewritten


def markdown_diff(original: str, proposed: str) -> str:
    return "\n".join(
        difflib.unified_diff(
            original.splitlines(),
            proposed.splitlines(),
            fromfile="当前版本",
            tofile="建议版本",
            lineterm="",
        )
    )
