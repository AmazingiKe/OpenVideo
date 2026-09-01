from __future__ import annotations

from typing import cast

import pytest
from agno.agent import Agent
from agno.models.base import Model
from agno.models.message import Message
from agno.models.response import ModelResponse
from agno.session.summary import SessionSummary, SessionSummaryManager

from openvideo.llm.agno_session_context import AgnoSessionContext


class RecordingModel(Model):
    def __init__(self) -> None:
        super().__init__(id="recording-model")
        self.requests: list[list[tuple[str, str]]] = []

    async def aresponse(self, messages, **_kwargs):
        self.requests.append(
            [(message.role, str(message.content)) for message in messages]
        )
        content = f"回答 {len(self.requests)}"
        messages.append(Message(role="assistant", content=content))
        return ModelResponse(content=content)

    def invoke(self, *_args, **_kwargs):
        raise NotImplementedError

    async def ainvoke(self, *_args, **_kwargs):
        raise NotImplementedError

    def invoke_stream(self, *_args, **_kwargs):
        raise NotImplementedError

    async def ainvoke_stream(self, *_args, **_kwargs):
        raise NotImplementedError
        yield

    def _parse_provider_response(self, response, **_kwargs):
        return ModelResponse(content=str(response))

    def _parse_provider_response_delta(self, response, **_kwargs):
        return ModelResponse(content=str(response))


@pytest.mark.asyncio
async def test_session_history_survives_context_recreation(tmp_path):
    database_path = tmp_path / "agent-context.sqlite3"
    first_context = AgnoSessionContext(database_path)

    imported = await first_context.ensure_session(
        "session-first",
        "summary",
        [
            {"role": "user", "content": "第一问"},
            {"role": "assistant", "content": "第一答"},
            {"role": "user", "content": "第二问"},
            {"role": "assistant", "content": "第二答"},
        ],
    )
    await first_context.close()

    second_context = AgnoSessionContext(database_path)
    imported_again = await second_context.ensure_session(
        "session-first",
        "summary",
        [],
    )
    session = await second_context.database.get_session("session-first")
    messages = session.get_messages(last_n_runs=3) if session else []
    await second_context.close()

    assert imported is True
    assert imported_again is False
    assert [(message.role, message.content) for message in messages] == [
        ("user", "第一问"),
        ("assistant", "第一答"),
        ("user", "第二问"),
        ("assistant", "第二答"),
    ]


@pytest.mark.asyncio
async def test_agno_agent_loads_previous_run_from_same_session(tmp_path):
    context = AgnoSessionContext(tmp_path / "agent-context.sqlite3")
    first_model = RecordingModel()
    first_agent = Agent(
        id="summary",
        model=first_model,
        db=context.database,
        session_id="session-first",
        add_history_to_context=True,
        num_history_runs=3,
        telemetry=False,
    )
    await first_agent.arun("第一问")

    second_model = RecordingModel()
    second_agent = Agent(
        id="summary",
        model=second_model,
        db=context.database,
        session_id="session-first",
        add_history_to_context=True,
        num_history_runs=3,
        telemetry=False,
    )
    await second_agent.arun("第二问")
    await context.close()

    assert second_model.requests == [
        [
            ("user", "第一问"),
            ("assistant", "回答 1"),
            ("user", "第二问"),
        ]
    ]


@pytest.mark.asyncio
async def test_sessions_keep_independent_history(tmp_path):
    context = AgnoSessionContext(tmp_path / "agent-context.sqlite3")
    await context.ensure_session(
        "session-first",
        "summary",
        [
            {"role": "user", "content": "甲"},
            {"role": "assistant", "content": "甲答"},
        ],
    )
    await context.ensure_session(
        "session-second",
        "summary",
        [
            {"role": "user", "content": "乙"},
            {"role": "assistant", "content": "乙答"},
        ],
    )

    first_session = await context.database.get_session("session-first")
    second_session = await context.database.get_session("session-second")
    await context.close()

    assert first_session is not None
    assert second_session is not None
    assert [message.content for message in first_session.get_messages()] == [
        "甲",
        "甲答",
    ]
    assert [message.content for message in second_session.get_messages()] == [
        "乙",
        "乙答",
    ]


@pytest.mark.asyncio
async def test_manual_compaction_persists_agno_summary(tmp_path, monkeypatch):
    context = AgnoSessionContext(tmp_path / "agent-context.sqlite3")
    await context.ensure_session(
        "session-first",
        "summary",
        [
            {"role": "user", "content": "旧问题"},
            {"role": "assistant", "content": "旧答案"},
        ],
    )

    async def create_summary(self, session, run_metrics=None):
        summary = SessionSummary(summary="已整理的旧对话")
        session.summary = summary
        return summary

    monkeypatch.setattr(
        SessionSummaryManager,
        "acreate_session_summary",
        create_summary,
    )

    compressed = await context.compact_session(
        "session-first",
        cast(Model, object()),
    )
    await context.close()

    reopened_context = AgnoSessionContext(tmp_path / "agent-context.sqlite3")
    session = await reopened_context.database.get_session("session-first")
    await reopened_context.close()

    assert compressed is True
    assert session is not None
    assert session.summary is not None
    assert session.summary.summary == "已整理的旧对话"
