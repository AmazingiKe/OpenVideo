from __future__ import annotations

from collections import defaultdict
from typing import Any

import pytest
from pydantic import BaseModel

from openvideo.agent_runtime import (
    AgentRuntime,
    AgentSessionStore,
    AgentTool,
    AgentToolRegistry,
    new_agent_run,
    provider_json_schema,
)
from openvideo.core.agent_runtime_models import (
    AgentArtifact,
    AgentDefinition,
    AgentEvent,
    AgentEventType,
    AgentModelResponse,
    AgentMode,
    AgentRun,
    AgentSession,
    AgentToolCall,
    AgentToolDescriptor,
)
from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.identifiers import uuid7


class MemoryRepository:
    def __init__(self) -> None:
        self.sessions: dict[str, AgentSession] = {}
        self.runs: dict[str, AgentRun] = {}
        self.events: dict[str, list[AgentEvent]] = defaultdict(list)
        self.artifacts: list[AgentArtifact] = []

    def save_agent_session(self, session: AgentSession) -> None:
        self.sessions[session.session_id] = session

    def load_agent_session(self, session_id: str) -> AgentSession | None:
        return self.sessions.get(session_id)

    def save_agent_run(self, run: AgentRun) -> None:
        self.runs[run.run_id] = run

    def load_agent_run(self, run_id: str) -> AgentRun | None:
        return self.runs.get(run_id)

    def load_agent_runs(self, session_id: str | None = None) -> list[AgentRun]:
        return [
            run
            for run in self.runs.values()
            if session_id is None or run.session_id == session_id
        ]

    def append_agent_event(
        self,
        session_id: str,
        run_id: str | None,
        event_type: AgentEventType,
        payload: dict[str, Any],
    ) -> AgentEvent:
        event = AgentEvent(
            event_id=f"event-{uuid7().hex}",
            session_id=session_id,
            sequence=len(self.events[session_id]) + 1,
            run_id=run_id,
            event_type=event_type,
            payload=payload,
        )
        self.events[session_id].append(event)
        return event

    def load_agent_events(
        self, session_id: str, *, after_sequence: int = 0
    ) -> list[AgentEvent]:
        return [
            event
            for event in self.events[session_id]
            if event.sequence > after_sequence
        ]

    def load_agent_artifacts(
        self, *, run_id: str | None = None, session_id: str | None = None
    ) -> list[AgentArtifact]:
        return [
            artifact
            for artifact in self.artifacts
            if (run_id is None or artifact.run_id == run_id)
            and (session_id is None or artifact.session_id == session_id)
        ]


class EchoInput(BaseModel):
    text: str
    note: str | None = None


class FakeAdapter:
    def __init__(self, responses: list[AgentModelResponse]) -> None:
        self.responses = responses
        self.messages: list[list[dict[str, Any]]] = []

    async def complete(self, model, messages, tools, on_chunk):
        self.messages.append(messages)
        response = self.responses.pop(0)
        if response.content:
            on_chunk(response.content)
        return response


def setup_runtime(responses: list[AgentModelResponse]):
    repository = MemoryRepository()
    session = AgentSession(
        session_id=f"session-{uuid7().hex}",
        agent_id="test",
        asset_id=str(uuid7()),
        title="测试",
    )
    repository.save_agent_session(session)
    registry = AgentToolRegistry()
    registry.register(
        AgentTool(
            name="echo",
            description="回显",
            parameters_model=EchoInput,
            handler=lambda parameters: {"ok": True, "text": parameters.text},
        )
    )
    adapter = FakeAdapter(responses)
    runtime = AgentRuntime(AgentSessionStore(repository), registry, adapter)
    run = new_agent_run(
        session.session_id,
        f"request-{uuid7().hex}",
        f"model-{uuid7().hex}",
    )
    repository.save_agent_run(run)
    model = AiModelConfiguration(name="测试", litellm_model="openai/test")
    definition = AgentDefinition(
        agent_id="test",
        title="测试",
        description="测试统一生命周期",
        mode=AgentMode.CHAT,
        prompt="测试 Agent",
        tools=[AgentToolDescriptor(name="echo", description="回显")],
    )
    return repository, adapter, runtime, run, model, definition


@pytest.mark.asyncio
async def test_plain_reply_uses_standardized_events():
    repository, _, runtime, run, model, definition = setup_runtime(
        [AgentModelResponse(content="真实回复")]
    )

    finished = await runtime.run(run, model, definition, "你好")

    assert finished.stage == "complete"
    event_types = [event.event_type for event in repository.events[run.session_id]]
    assert AgentEventType.RUN_STATUS in event_types
    assert AgentEventType.MESSAGE_DELTA in event_types
    assert AgentEventType.MESSAGE_COMPLETED in event_types
    assert event_types[-1] == AgentEventType.RUN_COMPLETED


@pytest.mark.asyncio
async def test_invalid_tool_arguments_can_be_retried_within_budget():
    invalid = AgentToolCall(call_id="call-invalid", name="echo", arguments={})
    valid = AgentToolCall(call_id="call-valid", name="echo", arguments={"text": "证据"})
    repository, adapter, runtime, run, model, definition = setup_runtime(
        [
            AgentModelResponse(tool_calls=[invalid]),
            AgentModelResponse(tool_calls=[valid]),
            AgentModelResponse(content="完成"),
        ]
    )

    finished = await runtime.run(run, model, definition, "执行工具")

    assert finished.stage == "complete"
    assert any(message["role"] == "tool" for message in adapter.messages[1])
    tool_events = [
        event
        for event in repository.events[run.session_id]
        if event.event_type == AgentEventType.TOOL_STATUS
    ]
    assert any(event.payload["stage"] == "failed" for event in tool_events)
    assert any(event.payload["stage"] == "completed" for event in tool_events)


@pytest.mark.asyncio
async def test_required_tool_missing_marks_run_failed():
    repository, _, runtime, run, model, definition = setup_runtime(
        [AgentModelResponse(content="跳过工具")]
    )
    definition = definition.model_copy(update={"required_tools": {"echo"}})

    finished = await runtime.run(run, model, definition, "必须执行")

    assert finished.stage == "failed"
    assert finished.error_code == "required_result_missing"
    assert repository.events[run.session_id][-1].event_type == AgentEventType.RUN_FAILED


@pytest.mark.asyncio
async def test_missing_declared_tool_blocks_run_before_provider_call():
    repository, adapter, runtime, run, model, definition = setup_runtime([])
    definition = definition.model_copy(
        update={"tools": [AgentToolDescriptor(name="missing", description="不存在")]}
    )

    with pytest.raises(Exception, match="不存在的工具"):
        await runtime.run(run, model, definition, "不能启动")

    assert adapter.messages == []
    assert repository.runs[run.run_id].stage == "pending"


@pytest.mark.asyncio
async def test_cancelled_run_does_not_call_provider():
    repository, adapter, runtime, run, model, definition = setup_runtime(
        [AgentModelResponse(content="不应返回")]
    )
    runtime.cancel(run.run_id)

    finished = await runtime.run(run, model, definition, "取消")

    assert finished.stage == "cancelled"
    assert adapter.messages == []
    assert (
        repository.events[run.session_id][-1].event_type == AgentEventType.RUN_CANCELLED
    )


def test_provider_schema_resolves_references_nullable_and_defaults():
    schema = provider_json_schema(EchoInput.model_json_schema())

    assert "$defs" not in schema
    assert "$ref" not in str(schema)
    assert "default" not in str(schema)
    assert schema["additionalProperties"] is False
    assert schema["properties"]["note"]["nullable"] is True
