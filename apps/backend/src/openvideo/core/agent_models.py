"""后台 Agent 的持久化任务、执行阶段与可恢复问题。"""

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class AgentType(StrEnum):
    TRANSCRIPT_CORRECTION = "transcript_correction"


class AgentExecutionMode(StrEnum):
    AUTOMATIC = "automatic"
    CHUNKED = "chunked"
    COMPRESSED = "compressed"


class AgentStage(StrEnum):
    PENDING = "pending"
    PREPARING = "preparing"
    INVOKING_MODEL = "invoking_model"
    VALIDATING = "validating"
    WAITING_FOR_INPUT = "waiting_for_input"
    APPLYING = "applying"
    COMPLETE = "complete"
    FAILED = "failed"
    CANCELLED = "cancelled"


TERMINAL_AGENT_STAGES = {
    AgentStage.COMPLETE,
    AgentStage.FAILED,
    AgentStage.CANCELLED,
}


class AgentQuestionType(StrEnum):
    CONTEXT_LIMIT = "context_limit"
    TRANSCRIPT_CHANGED = "transcript_changed"


class AgentQuestionAction(StrEnum):
    CHANGE_MODEL = "change_model"
    CHUNK = "chunk"
    COMPRESS = "compress"
    RERUN_LATEST = "rerun_latest"
    CANCEL = "cancel"


class AgentQuestion(BaseModel):
    question_id: str
    question_type: AgentQuestionType
    message: str
    actions: list[AgentQuestionAction]


class AgentJob(BaseModel):
    job_id: str
    asset_id: str
    agent_type: AgentType = AgentType.TRANSCRIPT_CORRECTION
    execution_mode: AgentExecutionMode = AgentExecutionMode.AUTOMATIC
    stage: AgentStage = AgentStage.PENDING
    progress_percent: float = 0
    message: str = "等待开始"
    ai_model_id: str
    segment_indices: list[int] | None = None
    transcript_checksum: str
    question: AgentQuestion | None = None
    error_message: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class AgentResponse(BaseModel):
    question_id: str
    action: AgentQuestionAction
    ai_model_id: str | None = None
