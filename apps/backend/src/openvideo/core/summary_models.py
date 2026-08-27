"""总结文档、媒体产物与导出的业务数据契约。"""

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class SummaryDetail(StrEnum):
    CONCISE = "concise"
    STANDARD = "standard"
    DETAILED = "detailed"


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
    ai_model_id: str | None = None
    detail: SummaryDetail = SummaryDetail.STANDARD
    create_subdocuments: bool = False
    subdocument_mode: str = "chapters"


class SummaryDocumentCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    markdown: str = ""


class SummaryDocumentUpdate(BaseModel):
    expected_revision: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    markdown: str | None = None
    position: int | None = Field(default=None, ge=0)


class SummaryDocumentReorder(BaseModel):
    document_ids: list[str]


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
    file_name: str
    size_bytes: int = Field(ge=0)
    exported_at: datetime
