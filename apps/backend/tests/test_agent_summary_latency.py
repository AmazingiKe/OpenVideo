from __future__ import annotations

import asyncio

import pytest
from pydantic import BaseModel
from agno.models.openai import OpenAIChat
from agno.models.response import ModelResponse
from agno.run.agent import RunCompletedEvent, RunContentCompletedEvent
from agno.run.base import RunStatus
from agno.session.summary import SessionSummaryManager

from openvideo.agent_runtime import AgentTool, AgentToolRegistry
from openvideo.core.agent_runtime_models import (
    AgentDefinition,
    AgentMode,
    AgentToolDescriptor,
)
from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.identifiers import uuid7
from openvideo.llm import agno_session_context
from openvideo.llm.agno_executor import AgnoAgentExecutor, AgentToolExecutionState
from openvideo.llm.agno_session_context import (
    AgnoSessionContext,
    BoundedSessionSummaryManager,
)
from openvideo.llm.events import LlmAgentEventType
from openvideo.llm.model_profile import ModelCapabilities, ModelProfile, Support


class EvidenceQuery(BaseModel):
    query: str


@pytest.mark.asyncio
async def test_sixth_answer_survives_stalled_auxiliary_session_summary(
    tmp_path, monkeypatch
):
    summary_calls = 0
    summary_cancelled = asyncio.Event()
    answer_visible_before_summary = []

    async def answer(self, *_args, **_kwargs):
        yield ModelResponse(content="已取得的回答")

    async def summarize(self, *_args, **_kwargs):
        nonlocal summary_calls
        summary_calls += 1
        answer_visible_before_summary.append(
            any(
                event.event_type == LlmAgentEventType.TEXT_DELTA
                and event.content == "已取得的回答"
                for event in events
            )
        )
        if summary_calls == 6:
            try:
                await asyncio.Future()
            finally:
                summary_cancelled.set()
        return ModelResponse(content='{"summary":"已经保存的历史摘要","topics":[]}')

    monkeypatch.setattr(OpenAIChat, "ainvoke_stream", answer)
    monkeypatch.setattr(OpenAIChat, "ainvoke", summarize)
    monkeypatch.setattr(
        "openvideo.llm.agno_executor.create_agent_model",
        lambda *_args, **_kwargs: OpenAIChat(
            id="dummy-model", api_key="dummy-not-real"
        ),
    )
    monkeypatch.setattr(
        agno_session_context, "SESSION_SUMMARY_TIMEOUT_SECONDS", 0.02, raising=False
    )
    context = AgnoSessionContext(tmp_path / "agent-context.sqlite3")
    session_id = f"session-{uuid7().hex}"
    definition = AgentDefinition(
        agent_id="test",
        title="多轮摘要测试",
        description="辅助摘要不应阻塞已生成的回答",
        mode=AgentMode.CHAT,
        prompt="回答用户的问题",
        tools=[AgentToolDescriptor(name="read_evidence", description="读取证据")],
    )
    model = AiModelConfiguration(name="测试模型", litellm_model="openai/dummy-model")
    profile = ModelProfile(
        provider="openai",
        model="dummy-model",
        capabilities=ModelCapabilities(tools=Support.YES),
    )
    registry = AgentToolRegistry()
    registry.register(
        AgentTool("read_evidence", "读取证据", EvidenceQuery, lambda _: {"ok": True})
    )
    try:
        for question_index in range(6):
            events = []
            result = await asyncio.wait_for(
                AgnoAgentExecutor(context).run(
                    model,
                    profile,
                    definition,
                    [{"role": "user", "content": f"第 {question_index + 1} 问"}],
                    registry,
                    events.append,
                    max_tool_calls=6,
                    tool_timeout_seconds=1,
                    session_id=session_id,
                ),
                timeout=1,
            )
            assert result.content == "已取得的回答"
            assert any(
                event.event_type == LlmAgentEventType.RESPONSE_COMPLETED
                for event in events
            )
        session = await context.database.get_session(session_id)
        assert len(session.runs) == 6
        assert all(run.status == RunStatus.completed for run in session.runs)
        assert session.summary.summary == "已经保存的历史摘要"
        assert summary_calls == 6
        assert summary_cancelled.is_set()
        assert all(answer_visible_before_summary)
    finally:
        await context.database.close()


@pytest.mark.asyncio
async def test_optional_summary_does_not_swallow_user_cancellation(monkeypatch):
    summary_started = asyncio.Event()
    provider_cancelled = asyncio.Event()

    async def summarize(self, session, run_metrics=None):
        summary_started.set()
        try:
            await asyncio.Future()
        finally:
            provider_cancelled.set()

    monkeypatch.setattr(SessionSummaryManager, "acreate_session_summary", summarize)
    manager = BoundedSessionSummaryManager(id=f"summary-{uuid7().hex}")
    task = asyncio.create_task(manager.acreate_session_summary(None))
    await asyncio.wait_for(summary_started.wait(), timeout=1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert provider_cancelled.is_set()


@pytest.mark.asyncio
async def test_empty_content_completion_waits_for_final_payload():
    async def stream():
        yield RunContentCompletedEvent()
        yield RunCompletedEvent(content="最终补充的回答")

    events = []
    result = await AgnoAgentExecutor._consume(
        stream(),
        events.append,
        required_tools=set(),
        tool_state=AgentToolExecutionState(max_tool_calls=6),
        has_tools=True,
    )
    assert result.content == "最终补充的回答"
    assert [event.event_type for event in events] == [
        LlmAgentEventType.TEXT_DELTA,
        LlmAgentEventType.RESPONSE_COMPLETED,
    ]
