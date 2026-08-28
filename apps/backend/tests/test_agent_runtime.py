from __future__ import annotations

import hashlib
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
    AgentContextAttachment,
    AgentDefinition,
    AgentEvent,
    AgentEventType,
    AgentMode,
    AgentRun,
    AgentSession,
    AgentToolCall,
    AgentToolDescriptor,
)
from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.identifiers import uuid7
from openvideo.llm.events import (
    AgentExecutionResult,
    LlmAgentEvent,
    LlmAgentEventType,
)
from openvideo.llm.model_profile import ModelCapabilities, ModelProfile, Support


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
        if run_id is not None and run_id in self.runs:
            self.runs[run_id] = self.runs[run_id].model_copy(
                update={
                    "latest_event_sequence": event.sequence,
                    "updated_at": event.created_at,
                }
            )
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


class FakeExecutor:
    def __init__(
        self,
        result: AgentExecutionResult,
        events: list[LlmAgentEvent] | None = None,
    ) -> None:
        self.result = result
        self.events = events or []
        self.messages: list[list[dict[str, Any]]] = []

    async def run(
        self,
        model,
        profile,
        definition,
        messages,
        registry,
        on_event,
        **_options,
    ):
        self.messages.append(messages)
        for event in self.events:
            on_event(event)
        return self.result


def setup_runtime(
    result: AgentExecutionResult,
    events: list[LlmAgentEvent] | None = None,
    *,
    tools_support: Support = Support.UNKNOWN,
):
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
    executor = FakeExecutor(result, events)
    runtime = AgentRuntime(AgentSessionStore(repository), registry, executor)
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
    profile = ModelProfile(
        provider="openai",
        model="test",
        capabilities=ModelCapabilities(tools=tools_support),
    )
    return repository, registry, executor, runtime, run, model, profile, definition


@pytest.mark.asyncio
async def test_plain_reply_uses_standardized_events():
    repository, _, _, runtime, run, model, profile, definition = setup_runtime(
        AgentExecutionResult(content="真实回复"),
        [
            LlmAgentEvent(
                event_type=LlmAgentEventType.TEXT_DELTA,
                content="真实回复",
            )
        ],
    )

    finished = await runtime.run(run, model, profile, definition, "你好")

    assert finished.stage == "complete"
    event_types = [event.event_type for event in repository.events[run.session_id]]
    assert AgentEventType.RUN_STATUS in event_types
    assert AgentEventType.MESSAGE_DELTA in event_types
    assert AgentEventType.MESSAGE_COMPLETED in event_types
    assert event_types[-1] == AgentEventType.RUN_COMPLETED


@pytest.mark.asyncio
async def test_runtime_persists_phase_metrics_without_raw_reasoning(monkeypatch):
    clock = iter((1.0, 1.1, 1.2, 1.3))
    monkeypatch.setattr("openvideo.agent_runtime.monotonic", lambda: next(clock))
    repository, _, _, runtime, run, model, profile, definition = setup_runtime(
        AgentExecutionResult(
            content="最终答案",
            reasoning_content="不应持久化的原始推理",
            retry_count=2,
        ),
        [
            LlmAgentEvent(
                event_type=LlmAgentEventType.REASONING_DELTA,
                content="不应持久化的原始推理",
            ),
            LlmAgentEvent(
                event_type=LlmAgentEventType.TEXT_DELTA,
                content="最终答案",
            ),
        ],
    )

    finished = await runtime.run(run, model, profile, definition, "复杂问题")

    events = repository.events[run.session_id]
    serialized_events = [event.model_dump(mode="json") for event in events]
    assert "不应持久化的原始推理" not in str(serialized_events)
    assert AgentEventType.REASONING_DELTA not in {event.event_type for event in events}
    phase_event = next(
        event
        for event in events
        if event.event_type == AgentEventType.RUN_STATUS
        and event.payload.get("phase") == "reasoning"
    )
    assert phase_event.payload == {"stage": "running", "phase": "reasoning"}
    metrics_event = next(
        event for event in events if event.event_type == AgentEventType.RUN_METRICS
    )
    assert metrics_event.payload == {
        "total_ms": 300,
        "time_to_first_token_ms": 200,
        "routing_ms": 0,
        "retrieval_ms": 0,
        "vision_ms": 0,
        "model_wait_ms": 100,
        "generation_ms": 200,
        "tool_ms": 0,
        "retry_count": 2,
        "tool_count": 0,
        "model_role": None,
        "selected_model_id": run.model_id,
        "final_status": "complete",
        "tool_durations_ms": {},
    }
    assert finished.metrics.model_dump(mode="json") == metrics_event.payload


@pytest.mark.asyncio
async def test_runtime_records_tool_latency_and_retry_count(monkeypatch):
    clock = iter((1.0, 1.05, 1.15, 1.2, 1.3))
    monkeypatch.setattr("openvideo.agent_runtime.monotonic", lambda: next(clock))
    repository, _, _, runtime, run, model, profile, definition = setup_runtime(
        AgentExecutionResult(
            content="完成",
            successful_tools={"echo"},
            tool_call_count=1,
            retry_count=1,
        ),
        [
            LlmAgentEvent(
                event_type=LlmAgentEventType.TOOL_CALL_STARTED,
                call_id="call-1",
                name="echo",
            ),
            LlmAgentEvent(
                event_type=LlmAgentEventType.TOOL_CALL_COMPLETED,
                call_id="call-1",
                name="echo",
                result={"ok": True},
            ),
            LlmAgentEvent(
                event_type=LlmAgentEventType.TEXT_DELTA,
                content="完成",
            ),
        ],
    )

    finished = await runtime.run(run, model, profile, definition, "执行工具")

    assert finished.metrics.tool_count == 1
    assert finished.metrics.tool_ms == 100
    assert finished.metrics.tool_durations_ms == {"echo": 100}
    assert finished.metrics.retry_count == 1
    assert finished.metrics.model_wait_ms == 50
    assert finished.metrics.time_to_first_token_ms == 200


@pytest.mark.asyncio
async def test_invalid_tool_arguments_are_retryable_for_agno_loop():
    _, registry, _, _, _, _, _, definition = setup_runtime(AgentExecutionResult())

    result = await registry.execute(
        AgentToolCall(call_id="call-invalid", name="echo", arguments={}),
        definition.allowed_tools,
        timeout_seconds=1,
    )

    assert result["error_code"] == "invalid_arguments"
    assert result["retryable"] is True


@pytest.mark.asyncio
async def test_required_tool_missing_marks_run_failed():
    repository, _, _, runtime, run, model, profile, definition = setup_runtime(
        AgentExecutionResult(content="跳过工具")
    )
    definition = definition.model_copy(update={"required_tools": {"echo"}})

    finished = await runtime.run(run, model, profile, definition, "必须执行")

    assert finished.stage == "failed"
    assert finished.error_code == "required_result_missing"
    assert repository.events[run.session_id][-1].event_type == AgentEventType.RUN_FAILED


@pytest.mark.asyncio
async def test_missing_declared_tool_blocks_run_before_provider_call():
    repository, _, executor, runtime, run, model, profile, definition = setup_runtime(
        AgentExecutionResult()
    )
    definition = definition.model_copy(
        update={"tools": [AgentToolDescriptor(name="missing", description="不存在")]}
    )

    with pytest.raises(Exception, match="不存在的工具"):
        await runtime.run(run, model, profile, definition, "不能启动")

    assert executor.messages == []
    assert repository.runs[run.run_id].stage == "pending"


@pytest.mark.asyncio
async def test_cancelled_run_does_not_call_provider():
    repository, _, executor, runtime, run, model, profile, definition = setup_runtime(
        AgentExecutionResult(content="不应返回")
    )
    runtime.cancel(run.run_id)

    finished = await runtime.run(run, model, profile, definition, "取消")

    assert finished.stage == "cancelled"
    assert executor.messages == []
    assert (
        repository.events[run.session_id][-1].event_type == AgentEventType.RUN_CANCELLED
    )


@pytest.mark.asyncio
async def test_capability_unknown_does_not_block_agent():
    _, _, executor, runtime, run, model, profile, definition = setup_runtime(
        AgentExecutionResult(content="允许尝试"),
        tools_support=Support.UNKNOWN,
    )

    finished = await runtime.run(run, model, profile, definition, "执行")

    assert finished.stage == "complete"
    assert len(executor.messages) == 1


@pytest.mark.asyncio
async def test_confirmed_unsupported_blocks_agent():
    _, _, executor, runtime, run, model, profile, definition = setup_runtime(
        AgentExecutionResult(),
        tools_support=Support.NO,
    )

    with pytest.raises(Exception, match="已确认不支持"):
        await runtime.run(run, model, profile, definition, "执行")

    assert executor.messages == []


def test_provider_schema_resolves_references_nullable_and_defaults():
    schema = provider_json_schema(EchoInput.model_json_schema())

    assert "$defs" not in schema
    assert "$ref" not in str(schema)
    assert "default" not in str(schema)
    assert schema["additionalProperties"] is False
    assert schema["properties"]["note"]["nullable"] is True


def test_context_attachments_enforce_snapshot_and_time_range_contracts():
    asset_id = str(uuid7())
    text_attachment = AgentContextAttachment(
        attachment_id=f"attachment-{uuid7().hex}",
        kind="summary_selection",
        asset_id=asset_id,
        label="总结选区",
        snapshot_text="选中的总结内容",
        content_digest=hashlib.sha256("选中的总结内容".encode("utf-8")).hexdigest(),
        selection_start=2,
        selection_end=10,
    )
    time_attachment = AgentContextAttachment(
        attachment_id=f"attachment-{uuid7().hex}",
        kind="time_range",
        asset_id=asset_id,
        label="时间线区域",
        start_seconds=10,
        end_seconds=20,
    )

    assert text_attachment.snapshot_text == "选中的总结内容"
    assert time_attachment.snapshot_text is None

    with pytest.raises(ValueError, match="文本快照"):
        AgentContextAttachment(
            attachment_id=f"attachment-{uuid7().hex}",
            kind="time_range",
            asset_id=asset_id,
            label="无效时间线区域",
            start_seconds=10,
            end_seconds=20,
            snapshot_text="不应附加",
        )
    with pytest.raises(ValueError, match="内容摘要"):
        AgentContextAttachment(
            attachment_id=f"attachment-{uuid7().hex}",
            kind="transcript_selection",
            asset_id=asset_id,
            label="无效字幕选区",
            snapshot_text="缺少摘要",
        )
    with pytest.raises(ValueError, match="摘要与快照不一致"):
        AgentContextAttachment(
            attachment_id=f"attachment-{uuid7().hex}",
            kind="transcript_selection",
            asset_id=asset_id,
            label="摘要被篡改的字幕选区",
            snapshot_text="字幕快照",
            content_digest="a" * 64,
        )
