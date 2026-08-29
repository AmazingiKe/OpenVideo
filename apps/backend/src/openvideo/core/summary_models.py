"""总结文档、媒体产物与导出的业务数据契约。"""

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field


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


class SummaryVersion(BaseModel):
    version_id: str
    asset_id: str
    preset_id: str
    preset_version: int = Field(ge=1)
    user_input: str | None = None
    ai_model_id: str
    detail: SummaryDetail
    output_language: str
    context_summary: SummaryContextSummary
    relative_path: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class SummaryDocument(BaseModel):
    document_id: str
    asset_id: str
    version_id: str
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
    version: SummaryVersion
    documents: list[SummaryDocument]
    context_capacity_unknown: bool = False


class SummaryDocumentCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    markdown: str = ""


class SummaryDocumentUpdate(BaseModel):
    expected_revision: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    markdown: str | None = None
    position: int | None = Field(default=None, ge=0)


class SummaryDocumentMove(BaseModel):
    parent_document_id: str
    position: int = Field(ge=0)


class SummaryMediaType(StrEnum):
    IMAGE = "image"
    GIF = "gif"


class SummaryMediaCreate(BaseModel):
    document_id: str
    expected_revision: int = Field(ge=1)
    media_type: SummaryMediaType
    start_seconds: float = Field(ge=0)
    end_seconds: float | None = Field(default=None, ge=0)
    insert_after: str | None = None
    caption: str = Field(min_length=1, max_length=500)


class SummaryMediaArtifact(BaseModel):
    media_id: str
    asset_id: str
    version_id: str
    document_id: str
    media_type: SummaryMediaType
    relative_path: str
    caption: str
    start_seconds: float
    end_seconds: float | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class SummaryExportResult(BaseModel):
    export_id: str
    relative_path: str
    version_id: str
    file_name: str
    size_bytes: int = Field(ge=0)
    exported_at: datetime
