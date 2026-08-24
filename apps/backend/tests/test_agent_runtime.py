from __future__ import annotations

from collections import defaultdict
from typing import Any

import pytest
from pydantic import BaseModel

from openvideo.agent_runtime import (
    AgentPreset,
    AgentRuntime,
    AgentSessionStore,
    AgentTool,
    AgentToolRegistry,
    new_agent_run,
)
from openvideo.core.agent_runtime_models import (
    AgentEvent,
    AgentEventType,
    AgentModelResponse,
    AgentRun,
    AgentSession,
    AgentToolCall,
)
from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.identifiers import uuid7


class MemoryRepository:
    def __init__(self) -> None:
        self.sessions: dict[str, AgentSession] = {}
        self.runs: dict[str, AgentRun] = {}
        self.events: dict[str, list[AgentEvent]] = defaultdict(list)

    def save_agent_session(self, session: AgentSession) -> None:
        self.sessions[session.session_id] = session

    def load_agent_session(self, session_id: str) -> AgentSession | None:
        return self.sessions.get(session_id)

    def save_agent_run(self, run: AgentRun) -> None:
        self.runs[run.run_id] = run

    def load_agent_run(self, run_id: str) -> AgentRun | None:
        return self.runs.get(run_id)

    def load_agent_runs(self) -> list[AgentRun]:
        return list(self.runs.values())

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


class EchoInput(BaseModel):
    text: str


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
        session_id=f"session-{uuid7().hex}", agent_type="test", title="测试"
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
    run = new_agent_run(session.session_id)
    repository.save_agent_run(run)
    model = AiModelConfiguration(name="测试", litellm_model="openai/test")
    preset = AgentPreset(
        persona="测试 Agent", dynamic_context=lambda: "", allowed_tools=("echo",)
    )
    return repository, adapter, runtime, run, model, preset


@pytest.mark.asyncio
async def test_plain_reply_records_real_assistant_message_without_tool_call():
    repository, _, runtime, run, model, preset = setup_runtime(
        [AgentModelResponse(content="真实回复")]
    )

    finished = await runtime.run(run, model, preset, "你好")

    assert finished.stage == "complete"
    events = repository.events[run.session_id]
    assert [event.event_type for event in events].count(AgentEventType.TOOL_CALL) == 0
    assistant = next(
        event for event in events if event.event_type == AgentEventType.ASSISTANT_MESSAGE
    )
    assert assistant.payload["content"] == "真实回复"


@pytest.mark.asyncio
async def test_tool_result_is_added_to_next_model_context():
    call = AgentToolCall(call_id="call-1", name="echo", arguments={"text": "证据"})
    repository, adapter, runtime, run, model, preset = setup_runtime(
        [
            AgentModelResponse(tool_calls=[call]),
            AgentModelResponse(content="根据证据回答"),
        ]
    )

    finished = await runtime.run(run, model, preset, "搜索后回答")

    assert finished.stage == "complete"
    assert any(message["role"] == "tool" for message in adapter.messages[1])
    event_types = [event.event_type for event in repository.events[run.session_id]]
    assert AgentEventType.TOOL_CALL in event_types
    assert AgentEventType.TOOL_RESULT in event_types


@pytest.mark.asyncio
async def test_archive_messages_do_not_enter_model_context():
    repository, adapter, runtime, run, model, preset = setup_runtime(
        [AgentModelResponse(content="新回复")]
    )
    repository.append_agent_event(
        run.session_id,
        None,
        AgentEventType.ARCHIVE_MESSAGE,
        {"role": "assistant", "content": "旧写死回复"},
    )

    await runtime.run(run, model, preset, "新问题")

    assert all(
        message.get("content") != "旧写死回复" for message in adapter.messages[0]
    )


@pytest.mark.asyncio
async def test_cancelled_run_closes_turn_without_calling_model():
    repository, adapter, runtime, run, model, preset = setup_runtime(
        [AgentModelResponse(content="不应返回")]
    )
    runtime.cancel(run.run_id)

    finished = await runtime.run(run, model, preset, "取消")

    assert finished.stage == "cancelled"
    assert adapter.messages == []
    assert repository.events[run.session_id][-2].event_type == AgentEventType.TURN_END


@pytest.mark.asyncio
async def test_invalid_tool_arguments_are_recorded_as_tool_result():
    call = AgentToolCall(call_id="call-invalid", name="echo", arguments={})
    repository, _, runtime, run, model, preset = setup_runtime(
        [
            AgentModelResponse(tool_calls=[call]),
            AgentModelResponse(content="参数无效，请补充内容"),
        ]
    )

    await runtime.run(run, model, preset, "执行工具")

    result = next(
        event
        for event in repository.events[run.session_id]
        if event.event_type == AgentEventType.TOOL_RESULT
    )
    assert result.payload["result"]["ok"] is False
    assert result.payload["result"]["error"] == "工具参数无效"


@pytest.mark.asyncio
async def test_step_limit_fails_with_explicit_reason():
    calls = [
        AgentModelResponse(
            tool_calls=[
                AgentToolCall(
                    call_id=f"call-{index}",
                    name="echo",
                    arguments={"text": "继续"},
                )
            ]
        )
        for index in range(2)
    ]
    repository, _, runtime, run, model, preset = setup_runtime(calls)

    finished = await runtime.run(run, model, preset, "循环", max_steps=2)

    assert finished.stage == "failed"
    assert finished.error_message == "Agent 单轮超过最大 Step 数 2"
