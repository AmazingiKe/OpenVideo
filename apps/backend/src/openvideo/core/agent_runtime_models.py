"""通用 Agent 的声明、运行状态与持久化事件模型。"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from openvideo.core.identifiers import is_prefixed_uuid7, is_uuid7
from openvideo.core.agent_governance_models import (
    AgentModelRole,
    AgentRetrievalScope,
    AgentThinkingMode,
)


class AgentMode(StrEnum):
    CHAT = "chat"
    TASK = "task"


class AgentContextAttachmentKind(StrEnum):
    SUMMARY_SELECTION = "summary_selection"
    TRANSCRIPT_SELECTION = "transcript_selection"
    TIME_RANGE = "time_range"


class AgentCapability(StrEnum):
    TOOLS = "tools"
    VISION = "vision"
    LONG_CONTEXT = "long_context"


class AgentEventType(StrEnum):
    RUN_STATUS = "run.status"
    MESSAGE_DELTA = "message.delta"
    REASONING_DELTA = "reasoning.delta"
    MESSAGE_COMPLETED = "message.completed"
    TOOL_STATUS = "tool.status"
    ARTIFACT_CREATED = "artifact.created"
    CONTEXT_COMPRESSED = "context.compressed"
    RUN_METRICS = "run.metrics"
    RUN_COMPLETED = "run.completed"
    RUN_FAILED = "run.failed"
    RUN_CANCELLED = "run.cancelled"


class AgentRunStage(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    WAITING_FOR_APPROVAL = "waiting_for_approval"
    COMPLETE = "complete"
    FAILED = "failed"
    CANCELLED = "cancelled"
    INTERRUPTED = "interrupted"


class AgentRunPhase(StrEnum):
    MODEL_WAIT = "model_wait"
    REASONING = "reasoning"
    TOOL = "tool"
    GENERATION = "generation"


TERMINAL_AGENT_RUN_STAGES = {
    AgentRunStage.WAITING_FOR_APPROVAL,
    AgentRunStage.COMPLETE,
    AgentRunStage.FAILED,
    AgentRunStage.CANCELLED,
    AgentRunStage.INTERRUPTED,
}


class AgentArtifactStatus(StrEnum):
    PENDING = "pending"
    APPLYING = "applying"
    APPROVED = "approved"
    REJECTED = "rejected"
    STALE = "stale"
    FAILED = "failed"


class AgentToolDescriptor(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=500)
    prerequisites: list[str] = Field(default_factory=list)


class AgentDefinition(BaseModel):
    agent_id: str = Field(pattern=r"^[a-z][a-z0-9_]{1,63}$")
    title: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=500)
    mode: AgentMode
    prompt: str = Field(min_length=1)
    required_capabilities: set[AgentCapability] = Field(default_factory=set)
    minimum_context_tokens: int = Field(default=8_000, ge=1_000)
    tools: list[AgentToolDescriptor] = Field(default_factory=list)
    required_tools: set[str] = Field(default_factory=set)
    requires_approval: bool = False
    result_type: str | None = None
    input_mode: Literal["message", "task"] = "message"

    @model_validator(mode="after")
    def validate_required_tools(self) -> "AgentDefinition":
        tool_names = {tool.name for tool in self.tools}
        missing = self.required_tools - tool_names
        if missing:
            raise ValueError(f"必需工具未声明：{', '.join(sorted(missing))}")
        if self.requires_approval and not self.result_type:
            raise ValueError("需要审批的 Agent 必须声明结果类型")
        return self

    @property
    def allowed_tools(self) -> tuple[str, ...]:
        return tuple(tool.name for tool in self.tools)


class AgentDefinitionAvailability(BaseModel):
    definition: AgentDefinition
    available: bool
    compatible_model_ids: list[str] = Field(default_factory=list)
    capability_model_ids: dict[AgentCapability, list[str]] = Field(default_factory=dict)
    unavailable_reason: str | None = None


class AgentSession(BaseModel):
    session_id: str
    agent_id: str
    asset_id: str
    title: str = Field(min_length=1, max_length=120)
    context: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class AgentEvent(BaseModel):
    event_id: str
    session_id: str
    sequence: int = Field(ge=1)
    run_id: str | None = None
    event_type: AgentEventType
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class AgentRunMetrics(BaseModel):
    """保留定位慢任务所需的阶段指标，不记录模型原始思维链。"""

    total_ms: int = Field(default=0, ge=0)
    time_to_first_token_ms: int | None = Field(default=None, ge=0)
    routing_ms: int = Field(default=0, ge=0)
    retrieval_ms: int = Field(default=0, ge=0)
    vision_ms: int = Field(default=0, ge=0)
    model_wait_ms: int = Field(default=0, ge=0)
    generation_ms: int = Field(default=0, ge=0)
    tool_ms: int = Field(default=0, ge=0)
    retry_count: int = Field(default=0, ge=0)
    tool_count: int = Field(default=0, ge=0)
    model_role: AgentModelRole | None = None
    selected_model_id: str | None = None
    final_status: AgentRunStage | None = None
    tool_durations_ms: dict[str, int] = Field(default_factory=dict)


class AgentRun(BaseModel):
    run_id: str
    session_id: str
    request_key: str
    model_id: str
    stage: AgentRunStage = AgentRunStage.PENDING
    error_code: str | None = None
    error_message: str | None = None
    latest_event_sequence: int = 0
    metrics: AgentRunMetrics = Field(default_factory=AgentRunMetrics)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    started_at: datetime | None = None
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    completed_at: datetime | None = None


class AgentArtifact(BaseModel):
    artifact_id: str
    run_id: str
    session_id: str
    agent_id: str
    asset_id: str
    result_type: str
    payload: dict[str, Any]
    status: AgentArtifactStatus = AgentArtifactStatus.PENDING
    error_message: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class AgentToolCall(BaseModel):
    call_id: str
    name: str
    arguments: dict[str, Any]


class AgentModelResponse(BaseModel):
    content: str = ""
    tool_calls: list[AgentToolCall] = Field(default_factory=list)


class AgentContextMessage(BaseModel):
    role: Literal["user", "assistant", "tool"]
    content: str
    tool_call_id: str | None = None
    tool_calls: list[dict[str, Any]] | None = None


class AgentContextAttachment(BaseModel):
    """把用户可见选择绑定到单条消息，同时保留可复现的来源快照。"""

    attachment_id: str
    kind: AgentContextAttachmentKind
    asset_id: str
    label: str = Field(min_length=1, max_length=200)
    reference_id: str | None = Field(default=None, min_length=1, max_length=200)
    version_id: str | None = Field(default=None, min_length=1, max_length=200)
    start_seconds: float | None = Field(default=None, ge=0)
    end_seconds: float | None = Field(default=None, ge=0)
    snapshot_text: str | None = Field(default=None, max_length=100_000)
    content_digest: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    selection_start: int | None = Field(default=None, ge=0)
    selection_end: int | None = Field(default=None, ge=0)

    @field_validator("attachment_id")
    @classmethod
    def validate_attachment_id(cls, value: str) -> str:
        if not is_prefixed_uuid7(value, "attachment-"):
            raise ValueError("上下文附件标识必须使用 attachment- 前缀和 UUIDv7 十六进制")
        return value

    @field_validator("asset_id")
    @classmethod
    def validate_asset_id(cls, value: str) -> str:
        if not is_uuid7(value):
            raise ValueError("上下文附件必须引用 UUIDv7 媒体资源标识")
        return value

    @model_validator(mode="after")
    def validate_attachment_payload(self) -> "AgentContextAttachment":
        is_time_range = self.kind == AgentContextAttachmentKind.TIME_RANGE
        if is_time_range:
            if (
                self.start_seconds is None
                or self.end_seconds is None
                or self.end_seconds <= self.start_seconds
            ):
                raise ValueError("时间范围附件必须提供有效的起止时间")
            if self.snapshot_text is not None:
                raise ValueError("时间范围附件只保存引用，不能携带文本快照")
            if self.selection_start is not None or self.selection_end is not None:
                raise ValueError("时间范围附件不能携带文本选择位置")
            return self
        if self.snapshot_text is None or self.content_digest is None:
            raise ValueError("文本选择附件必须保存文本快照与内容摘要")
        if self.start_seconds is not None or self.end_seconds is not None:
            raise ValueError("文本选择附件不能携带时间范围")
        if (self.selection_start is None) != (self.selection_end is None):
            raise ValueError("文本选择位置必须同时提供起点与终点")
        if (
            self.selection_start is not None
            and self.selection_end is not None
            and self.selection_end <= self.selection_start
        ):
            raise ValueError("文本选择终点必须晚于起点")
        return self


class AgentSessionCreate(BaseModel):
    agent_id: str
    asset_id: str
    title: str | None = Field(default=None, max_length=120)
    context: dict[str, Any] = Field(default_factory=dict)


class AgentRunCreate(BaseModel):
    request_key: str
    ai_model_id: str
    content: str = Field(default="", max_length=100_000)
    thinking_mode: AgentThinkingMode = AgentThinkingMode.AUTO
    retrieval_scope: AgentRetrievalScope = AgentRetrievalScope.CURRENT_ASSET
    context_attachments: list[AgentContextAttachment] = Field(
        default_factory=list, max_length=32
    )
    task_input: dict[str, Any] = Field(default_factory=dict)

    @field_validator("request_key")
    @classmethod
    def validate_request_key(cls, request_key: str) -> str:
        if not is_prefixed_uuid7(request_key, "request-"):
            raise ValueError("请求键必须使用 request- 前缀和 UUIDv7 十六进制")
        return request_key


class AgentSessionState(BaseModel):
    session: AgentSession
    runs: list[AgentRun] = Field(default_factory=list)
    events: list[AgentEvent] = Field(default_factory=list)
    artifacts: list[AgentArtifact] = Field(default_factory=list)
