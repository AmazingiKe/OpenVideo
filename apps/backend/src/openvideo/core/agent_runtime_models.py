"""Agent 会话事件是模型上下文、运行恢复和 UI 流式展示的唯一事实来源。"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field


class AgentEventType(StrEnum):
    TURN_START = "turn/start"
    TURN_END = "turn/end"
    STEP_START = "step/start"
    STEP_END = "step/end"
    USER_MESSAGE = "user/message"
    ASSISTANT_CHUNK = "assistant/chunk"
    ASSISTANT_MESSAGE = "assistant/message"
    TOOL_CALL = "tool/call"
    TOOL_RESULT = "tool/result"
    RUN_STATUS = "run/status"
    ARCHIVE_MESSAGE = "archive/message"


class AgentRunStage(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETE = "complete"
    FAILED = "failed"
    CANCELLED = "cancelled"
    INTERRUPTED = "interrupted"


class AgentSession(BaseModel):
    session_id: str
    agent_type: str
    title: str = Field(min_length=1, max_length=120)
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


class AgentRun(BaseModel):
    run_id: str
    session_id: str
    stage: AgentRunStage = AgentRunStage.PENDING
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
    degraded_reason: str | None = None


class AgentContextMessage(BaseModel):
    role: Literal["user", "assistant", "tool"]
    content: str
    tool_call_id: str | None = None
    tool_calls: list[dict[str, Any]] | None = None
