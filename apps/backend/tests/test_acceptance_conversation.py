"""Exercise persisted conversation lifecycles through real HTTP and Agno layers.

Only provider responses and intent routing are controlled; this suite does not
measure model understanding or claim live-provider acceptance.
"""

from __future__ import annotations

import asyncio
import json
from threading import Event

from agno.models.openai import OpenAIChat
from agno.models.response import ModelResponse
from agno.run.base import RunStatus
from fastapi.testclient import TestClient
from openai.types.chat.chat_completion_chunk import (
    ChoiceDeltaToolCall,
    ChoiceDeltaToolCallFunction,
)

from openvideo.core.identifiers import uuid7
from openvideo.ui.api import create_app
from test_api_agents import ASSET_ID, MODEL_ID, create_client


TURN_COUNT_BEFORE_REOPEN = 12
TURN_COUNT_AFTER_REOPEN = 3
FIRST_TURN_SENTINEL = "独立验收：记住蓝鲸四十二"


def configure_provider(monkeypatch, invoke_stream):
    async def invoke(_self, *_args, **_kwargs):
        return ModelResponse(content='{"summary":"独立会话验收","topics":[]}')

    monkeypatch.setattr(OpenAIChat, "ainvoke_stream", invoke_stream)
    monkeypatch.setattr(OpenAIChat, "ainvoke", invoke)
    monkeypatch.setattr(
        "openvideo.llm.agno_executor.create_agent_model",
        lambda *_args, **_kwargs: OpenAIChat(id="test", api_key="test"),
    )
    monkeypatch.setattr(
        "openvideo.agent_intent_router.complete_text",
        lambda *_args, **_kwargs: json.dumps(
            {
                "intent": "chat",
                "model_role": "fast",
                "reason": "只验收会话记忆和任务生命周期",
                "needs_evidence": False,
            }
        ),
    )


def submit_run(client, session_id, content):
    response = client.post(
        f"/api/agent-sessions/{session_id}/runs",
        json={
            "request_key": f"request-{uuid7().hex}",
            "ai_model_id": MODEL_ID,
            "content": content,
        },
    )
    assert response.status_code == 202, response.text
    return response.json()


def assert_completed_stream(client, run_id):
    stream = client.get(f"/api/agent-runs/{run_id}/events")
    assert stream.status_code == 200
    assert "event: run.completed" in stream.text, stream.text
    assert "event: run.failed" not in stream.text
    assert "event: message.completed" in stream.text
    run = client.get(f"/api/agent-runs/{run_id}").json()
    assert run["stage"] == "complete", run
    return stream.text


def test_fifteen_http_turns_persist_and_recall_after_reopening(tmp_path, monkeypatch):
    provider_requests = []
    history_requested = False

    async def invoke_stream(_self, messages, **_kwargs):
        nonlocal history_requested
        provider_requests.append([message.content for message in messages])
        last_user = max(
            index for index, message in enumerate(messages) if message.role == "user"
        )
        question = messages[last_user].content
        current_tool_messages = [
            message.content
            for message in messages[last_user + 1 :]
            if message.role == "tool"
        ]
        if question == "独立验收：取回最初口令":
            if not current_tool_messages:
                history_requested = True
                yield ModelResponse(
                    tool_calls=[
                        ChoiceDeltaToolCall(
                            index=0,
                            id="acceptance-history",
                            type="function",
                            function=ChoiceDeltaToolCallFunction(
                                name="get_chat_history", arguments='{"num_chats":null}'
                            ),
                        )
                    ]
                )
                return
            assert any(
                FIRST_TURN_SENTINEL in str(item) for item in current_tool_messages
            )
        yield ModelResponse(content=f"已完成：{question}")

    configure_provider(monkeypatch, invoke_stream)
    run_ids = []
    with create_client(tmp_path) as client:
        session_response = client.post(
            "/api/agent-sessions",
            json={"agent_id": "marker", "asset_id": ASSET_ID},
        )
        assert session_response.status_code == 201
        session_id = session_response.json()["session_id"]
        settings = client.app.state.agent_service.settings
        capability_resolver = client.app.state.agent_service.capability_resolver
        for turn in range(TURN_COUNT_BEFORE_REOPEN):
            content = FIRST_TURN_SENTINEL if turn == 0 else f"独立验收：问题 {turn + 1}"
            run = submit_run(client, session_id, content)
            run_ids.append(run["run_id"])
            assert_completed_stream(client, run["run_id"])

    with TestClient(
        create_app(settings, capability_resolver=capability_resolver)
    ) as client:
        for turn in range(TURN_COUNT_AFTER_REOPEN):
            content = (
                "独立验收：取回最初口令"
                if turn == TURN_COUNT_AFTER_REOPEN - 1
                else f"独立验收：重开后的问题 {turn + 1}"
            )
            run = submit_run(client, session_id, content)
            run_ids.append(run["run_id"])
            assert_completed_stream(client, run["run_id"])
        state = client.get(f"/api/agent-sessions/{session_id}").json()
        persisted = client.portal.call(
            client.app.state.agent_service.agno_session_context.database.get_session,
            session_id,
        )

    total_turns = TURN_COUNT_BEFORE_REOPEN + TURN_COUNT_AFTER_REOPEN
    assert len(set(run_ids)) == total_turns
    assert len(state["runs"]) == total_turns
    completed_messages = [
        event for event in state["events"] if event["event_type"] == "message.completed"
    ]
    assert len(completed_messages) == total_turns
    assert len(persisted.runs) == total_turns
    assert all(run.status == RunStatus.completed for run in persisted.runs)
    assert len(provider_requests) == total_turns + 1
    assert history_requested


def test_cancelled_http_provider_run_releases_session_for_next_turn(
    tmp_path, monkeypatch
):
    started = Event()

    async def invoke_stream(_self, messages, **_kwargs):
        question = next(
            message.content for message in reversed(messages) if message.role == "user"
        )
        if question == "独立验收：等待取消":
            started.set()
            await asyncio.Event().wait()
        yield ModelResponse(content="取消后的下一轮正常完成")

    configure_provider(monkeypatch, invoke_stream)
    with create_client(tmp_path) as client:
        session_id = client.post(
            "/api/agent-sessions",
            json={"agent_id": "marker", "asset_id": ASSET_ID},
        ).json()["session_id"]
        cancelled = submit_run(client, session_id, "独立验收：等待取消")
        assert started.wait(timeout=5)
        response = client.post(f"/api/agent-runs/{cancelled['run_id']}/cancel")
        assert response.status_code == 200
        assert response.json()["stage"] == "cancelled"
        recovered = submit_run(client, session_id, "独立验收：取消后继续")
        assert_completed_stream(client, recovered["run_id"])
        state = client.get(f"/api/agent-sessions/{session_id}").json()
    assert [run["stage"] for run in state["runs"]] == ["cancelled", "complete"]
