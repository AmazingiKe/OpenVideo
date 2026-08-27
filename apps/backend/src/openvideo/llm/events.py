from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class LlmAgentEventType(StrEnum):
    TEXT_DELTA = "text_delta"
    REASONING_DELTA = "reasoning_delta"
    TOOL_CALL_STARTED = "tool_call_started"
    TOOL_CALL_COMPLETED = "tool_call_completed"
    RESPONSE_COMPLETED = "response_completed"


class LlmAgentEvent(BaseModel):
    event_type: LlmAgentEventType
    content: str = ""
    call_id: str | None = None
    name: str | None = None
    arguments: dict[str, Any] = Field(default_factory=dict)
    result: dict[str, Any] | None = None
    failed: bool = False


class AgentExecutionResult(BaseModel):
    content: str = ""
    reasoning_content: str = ""
    successful_tools: set[str] = Field(default_factory=set)
    tool_call_count: int = Field(default=0, ge=0)
