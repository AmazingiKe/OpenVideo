"""总结文档、对话建议与媒体产物共享的数据契约。"""

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field, model_validator


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


class SummaryConversation(BaseModel):
    conversation_id: str
    asset_id: str
    root_document_id: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class SummaryMessageRole(StrEnum):
    USER = "user"
    ASSISTANT = "assistant"


class SummaryMessage(BaseModel):
    message_id: str
    conversation_id: str
    role: SummaryMessageRole
    content: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class SummarySelection(BaseModel):
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    text: str = ""

    @model_validator(mode="after")
    def validate_range(self) -> "SummarySelection":
        if self.end < self.start:
            raise ValueError("选区结束位置不能早于开始位置")
        return self


class SummaryAgentMessageRequest(BaseModel):
    document_id: str
    expected_revision: int = Field(ge=1)
    instruction: str = Field(min_length=1, max_length=20_000)
    ai_model_id: str
    selection: SummarySelection | None = None


class SummaryMediaType(StrEnum):
    IMAGE = "image"
    GIF = "gif"


class SummaryMediaSuggestion(BaseModel):
    suggestion_id: str
    media_type: SummaryMediaType
    start_seconds: float = Field(ge=0)
    end_seconds: float | None = Field(default=None, ge=0)
    insert_after: str | None = None
    caption: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_time_range(self) -> "SummaryMediaSuggestion":
        if self.end_seconds is not None and self.end_seconds <= self.start_seconds:
            raise ValueError("媒体结束时间必须晚于开始时间")
        return self


class SummaryProposalStatus(StrEnum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    STALE = "stale"


class SummaryEditProposal(BaseModel):
    proposal_id: str
    conversation_id: str
    document_id: str
    base_revision: int = Field(ge=1)
    proposed_markdown: str
    explanation: str
    diff: str
    suggested_subdocuments: list[SummaryDocumentCreate] = Field(default_factory=list)
    media_suggestions: list[SummaryMediaSuggestion] = Field(default_factory=list)
    status: SummaryProposalStatus = SummaryProposalStatus.PENDING
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class SummaryAgentRunStage(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETE = "complete"
    FAILED = "failed"


class SummaryAgentRun(BaseModel):
    run_id: str
    conversation_id: str
    stage: SummaryAgentRunStage = SummaryAgentRunStage.PENDING
    assistant_message_id: str | None = None
    proposal_id: str | None = None
    error_message: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class SummaryConversationState(BaseModel):
    conversation: SummaryConversation
    messages: list[SummaryMessage]
    proposals: list[SummaryEditProposal]


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
