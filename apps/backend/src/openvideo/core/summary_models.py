"""总结文档、媒体产物与导出的业务数据契约。"""

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from openvideo.core.agent_evidence_models import AgentEvidenceSource


class SummaryDetail(StrEnum):
    CONCISE = "concise"
    STANDARD = "standard"
    DETAILED = "detailed"


class SummaryPreset(BaseModel):
    """只读角色提示词独立于 Agent Runtime，保证生成职责和权限不混用。"""

    preset_id: str
    title: str
    description: str
    prompt: str
    minimum_context_tokens: int = Field(ge=1_000)
    version: int = Field(ge=1)


class SummaryContextSummary(BaseModel):
    transcript_digest: str
    marker_digest: str
    event_analysis_digest: str


class SummaryProject(BaseModel):
    """描述素材唯一的当前笔记及最近一次生成依据。"""

    asset_id: str
    revision: int = Field(default=1, ge=1)
    root_document_id: str
    preset_id: str
    preset_version: int = Field(ge=1)
    user_input: str | None = None
    ai_model_id: str
    detail: SummaryDetail
    output_language: str
    context_summary: SummaryContextSummary
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class SummaryDocument(BaseModel):
    document_id: str
    asset_id: str
    parent_document_id: str | None = None
    title: str = Field(min_length=1, max_length=200)
    markdown: str = ""
    relative_path: str = ""
    content_digest: str = ""
    position: int = Field(default=0, ge=0)
    revision: int = Field(default=1, ge=1)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class SummaryGenerationRequest(BaseModel):
    ai_model_id: str
    preset_id: str
    user_input: str | None = Field(default=None, max_length=20_000)
    detail: SummaryDetail = SummaryDetail.STANDARD
    output_language: str = Field(default="zh-CN", min_length=2, max_length=40)


class SummaryGenerationResult(BaseModel):
    project: SummaryProject
    documents: list[SummaryDocument]
    context_capacity_unknown: bool = False
    illustration_job: "SummaryIllustrationJob | None" = None


class SummaryDocumentCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    markdown: str = ""


class SummaryDocumentUpdate(BaseModel):
    operation_id: str = Field(pattern=r"^summary-operation-[0-9a-f]{32}$")
    client_id: str = Field(pattern=r"^summary-client-[0-9a-f]{32}$")
    client_sequence: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    markdown: str | None = None


class SummaryDocumentMove(BaseModel):
    parent_document_id: str
    position: int = Field(ge=0)


class SummaryMediaType(StrEnum):
    IMAGE = "image"
    GIF = "gif"


class SummaryMediaOrigin(StrEnum):
    MANUAL = "manual"
    AUTOMATIC = "automatic"


class SummaryIllustrationConfidence(StrEnum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class SummaryIllustrationStage(StrEnum):
    PENDING = "pending"
    PLANNING = "planning"
    RETRIEVING = "retrieving"
    EXTRACTING = "extracting"
    VALIDATING = "validating"
    COMPLETE = "complete"
    FAILED = "failed"


TERMINAL_SUMMARY_ILLUSTRATION_STAGES = {
    SummaryIllustrationStage.COMPLETE,
    SummaryIllustrationStage.FAILED,
}


class SummaryIllustrationSlotStatus(StrEnum):
    PENDING = "pending"
    LOCATING = "locating"
    VALIDATING = "validating"
    INSERTED = "inserted"
    SKIPPED = "skipped"


class SummaryIllustrationSlot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    slot_id: str
    document_id: str
    heading_path: list[str] = Field(default_factory=list, max_length=12)
    target_excerpt: str = Field(min_length=1, max_length=500)
    retrieval_query: str = Field(min_length=1, max_length=500)
    caption: str = Field(min_length=1, max_length=500)
    status: SummaryIllustrationSlotStatus = SummaryIllustrationSlotStatus.PENDING
    candidate_times: list[float] = Field(default_factory=list, max_length=7)
    selected_time: float | None = Field(default=None, ge=0)
    confidence: SummaryIllustrationConfidence | None = None
    source_excerpt: str | None = Field(default=None, max_length=2_000)
    source_types: list[AgentEvidenceSource] = Field(default_factory=list)
    media_id: str | None = None
    message: str = "等待定位"


class SummaryIllustrationMetrics(BaseModel):
    model_config = ConfigDict(extra="forbid")

    planning_ms: int = Field(default=0, ge=0)
    retrieval_ms: int = Field(default=0, ge=0)
    frame_processing_ms: int = Field(default=0, ge=0)
    vision_ms: int = Field(default=0, ge=0)
    total_ms: int = Field(default=0, ge=0)
    vision_calls: int = Field(default=0, ge=0)


class SummaryIllustrationJob(BaseModel):
    """记录首次总结配图的可恢复进度，正文生成不依赖任务成功。"""

    model_config = ConfigDict(extra="forbid")

    job_id: str
    asset_id: str
    project_revision: int = Field(ge=1)
    planning_model_id: str
    vision_model_id: str | None = None
    stage: SummaryIllustrationStage = SummaryIllustrationStage.PENDING
    progress_percent: float = Field(default=0, ge=0, le=100)
    message: str = "正在准备配图"
    slots: list[SummaryIllustrationSlot] = Field(default_factory=list, max_length=6)
    inserted_count: int = Field(default=0, ge=0, le=6)
    skipped_count: int = Field(default=0, ge=0, le=6)
    metrics: SummaryIllustrationMetrics = Field(
        default_factory=SummaryIllustrationMetrics
    )
    error_message: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class SummaryMediaCreate(BaseModel):
    document_id: str
    expected_revision: int = Field(ge=1)
    media_type: SummaryMediaType
    start_seconds: float = Field(ge=0)
    end_seconds: float | None = Field(default=None, ge=0)
    insert_after: str | None = None
    caption: str = Field(min_length=1, max_length=500)


class SummaryMediaProvenance(BaseModel):
    """保存自动选图的证据链，使插图决策可解释并可离线评估。"""

    model_config = ConfigDict(extra="forbid")

    origin: SummaryMediaOrigin = SummaryMediaOrigin.AUTOMATIC
    target_heading_path: list[str] = Field(default_factory=list, max_length=12)
    source_excerpt: str | None = Field(default=None, max_length=2_000)
    source_types: list[AgentEvidenceSource] = Field(default_factory=list)
    candidate_times: list[float] = Field(default_factory=list, max_length=7)
    vision_model_id: str | None = None
    validation_confidence: SummaryIllustrationConfidence | None = None
    validation_summary: str | None = Field(default=None, max_length=2_000)


class SummaryMediaArtifact(BaseModel):
    media_id: str
    asset_id: str
    document_id: str
    media_type: SummaryMediaType
    relative_path: str
    caption: str
    start_seconds: float
    end_seconds: float | None = None
    origin: SummaryMediaOrigin = SummaryMediaOrigin.MANUAL
    target_heading_path: list[str] = Field(default_factory=list)
    source_excerpt: str | None = None
    source_types: list[AgentEvidenceSource] = Field(default_factory=list)
    candidate_times: list[float] = Field(default_factory=list)
    vision_model_id: str | None = None
    validation_confidence: SummaryIllustrationConfidence | None = None
    validation_summary: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class SummaryExportResult(BaseModel):
    export_id: str
    relative_path: str
    file_name: str
    size_bytes: int = Field(ge=0)
    exported_at: datetime


SummaryGenerationResult.model_rebuild()
