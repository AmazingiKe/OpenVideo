from __future__ import annotations

import difflib
import hashlib
import json
import re
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from openvideo.agent_runtime import AgentCancellation, AgentRuntimeError
from openvideo.core.agent_runtime_models import (
    AgentArtifact,
    AgentEventType,
    AgentRun,
    AgentSession,
)
from openvideo.core.agent_evidence_models import (
    AgentAnswerStatus,
    AgentEvidenceBundle,
    AgentEvidenceConfidence,
    AgentEvidenceCoverage,
    AgentEvidenceSearchResult,
    AgentEvidenceWriteDecision,
)
from openvideo.core.agent_governance_models import AgentRetrievalScope
from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.identifiers import uuid7
from openvideo.core.media_models import MediaMarker, MediaSegment
from openvideo.core.summary_models import SummaryDocumentCreate, SummaryMediaType

if TYPE_CHECKING:
    from openvideo.agent_service import AgentService


ARTIFACT_EVIDENCE_GATE_KEY = "evidence_gate"


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


class ListSummaryDocumentsInput(BaseModel):
    version_id: str | None = None


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
    instruction: str | None = Field(default=None, min_length=1, max_length=4_000)
    execution_mode: str = Field(
        default="automatic", pattern=r"^(automatic|chunked|compressed)$"
    )


@dataclass
class RunEvidenceState:
    markers_read: bool = False
    evidence_read: bool = False
    frames_inspected: bool = False
    summary_read_document_ids: set[str] = field(default_factory=set)
    inspected_frame_times: list[float] = field(default_factory=list)
    inspected_frame_ranges: list[tuple[float, float]] = field(default_factory=list)
    searches: list[AgentEvidenceSearchResult] = field(default_factory=list)

    def record_search(
        self, result: AgentEvidenceSearchResult
    ) -> AgentEvidenceSearchResult:
        citation_offset = sum(
            len(search.evidence_bundle.items) for search in self.searches
        )
        items = [
            item.model_copy(update={"citation_key": f"E{citation_offset + index}"})
            for index, item in enumerate(result.evidence_bundle.items, start=1)
        ]
        recorded = result.model_copy(
            update={
                "evidence_bundle": result.evidence_bundle.model_copy(
                    update={"items": items}
                )
            }
        )
        self.searches.append(recorded)
        self.evidence_read = True
        return recorded

    def write_decision(self) -> AgentEvidenceWriteDecision:
        items = [
            item for search in self.searches for item in search.evidence_bundle.items
        ]
        if not self.searches or not items:
            return AgentEvidenceWriteDecision(
                allowed=False,
                confidence=AgentEvidenceConfidence.LOW,
                reason="写入前没有检索到可核验证据",
            )
        confidence = min(
            (search.confidence for search in self.searches),
            key=lambda value: {
                AgentEvidenceConfidence.LOW: 0,
                AgentEvidenceConfidence.MEDIUM: 1,
                AgentEvidenceConfidence.HIGH: 2,
            }[value],
        )
        conflicts = [
            conflict
            for search in self.searches
            for conflict in search.evidence_bundle.conflicts
        ]
        allowed = confidence != AgentEvidenceConfidence.LOW and not conflicts
        if conflicts:
            reason = "证据存在未消除冲突，程序已阻止写入"
        elif confidence == AgentEvidenceConfidence.LOW:
            reason = "证据确定性低，程序已阻止写入"
        else:
            confidence_label = {
                AgentEvidenceConfidence.MEDIUM: "中",
                AgentEvidenceConfidence.HIGH: "高",
            }[confidence]
            reason = f"证据确定性{confidence_label}，允许进入写入审批"
        return AgentEvidenceWriteDecision(
            allowed=allowed,
            confidence=confidence,
            reason=reason,
            evidence_ids=sorted({item.evidence_id for item in items}),
            source_versions=sorted({item.source_version for item in items}),
        )


@dataclass
class AgentRunContext:
    service: AgentService
    session: AgentSession
    run: AgentRun
    model: AiModelConfiguration
    task_input: dict[str, Any]
    retrieval_scope: AgentRetrievalScope = AgentRetrievalScope.CURRENT_ASSET
    evidence: RunEvidenceState = field(default_factory=RunEvidenceState)
    cancellation: AgentCancellation = field(default_factory=AgentCancellation)

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

    def completion_payload(self, content: str) -> dict[str, Any]:
        """把程序验证过的证据状态附到最终消息，防止模型自行声明可信度。"""

        if not self.evidence.searches:
            return {}
        items = [
            item
            for search in self.evidence.searches
            for item in search.evidence_bundle.items
        ]
        citation_keys = {item.citation_key for item in items}
        cited_keys = set(re.findall(r"\[([A-Z]\d+)\]", content))
        invalid_citations = sorted(cited_keys - citation_keys)
        cited_searches = [
            search
            for search in self.evidence.searches
            if any(
                item.citation_key in cited_keys for item in search.evidence_bundle.items
            )
        ]
        relevant_searches = cited_searches or self.evidence.searches
        missing_citations = bool(citation_keys) and not cited_keys
        confidence = min(
            (search.confidence for search in relevant_searches),
            key=lambda value: {
                AgentEvidenceConfidence.LOW: 0,
                AgentEvidenceConfidence.MEDIUM: 1,
                AgentEvidenceConfidence.HIGH: 2,
            }[value],
        )
        relevant_items = [
            item
            for search in relevant_searches
            for item in search.evidence_bundle.items
        ]
        relevant_evidence_ids = {item.evidence_id for item in relevant_items}
        conflicts = [
            conflict
            for search in relevant_searches
            for conflict in search.evidence_bundle.conflicts
            if set(conflict.evidence_ids) <= relevant_evidence_ids
        ]
        source_types = sorted(
            {
                source_type
                for item in relevant_items
                for source_type in (
                    item.source_type,
                    *item.supporting_source_types,
                )
            },
            key=lambda source_type: source_type.value,
        )
        coverage = AgentEvidenceCoverage(
            temporal=max(
                search.evidence_bundle.coverage.temporal for search in relevant_searches
            ),
            source_types=source_types,
        )
        bundle = AgentEvidenceBundle(
            query=(
                relevant_searches[-1].evidence_bundle.query
                if len(relevant_searches) == 1
                else None
            ),
            items=relevant_items,
            conflicts=conflicts,
            coverage=coverage,
        )
        answer_status = (
            AgentAnswerStatus.INSUFFICIENT
            if not relevant_items
            else (
                AgentAnswerStatus.PROVISIONAL
                if confidence == AgentEvidenceConfidence.LOW or conflicts
                else AgentAnswerStatus.FINAL
            )
        )
        payload = {
            "confidence": confidence.value,
            "answer_status": answer_status.value,
            "evidence_bundle": bundle.model_dump(mode="json"),
        }
        if invalid_citations or missing_citations:
            payload.update(
                {
                    "confidence": AgentEvidenceConfidence.LOW.value,
                    "answer_status": AgentAnswerStatus.PROVISIONAL.value,
                    "citation_validation": {
                        "valid": False,
                        "invalid_citations": invalid_citations,
                        "missing_citations": missing_citations,
                    },
                }
            )
        else:
            payload["citation_validation"] = {
                "valid": True,
                "invalid_citations": [],
                "missing_citations": False,
            }
        return payload


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
