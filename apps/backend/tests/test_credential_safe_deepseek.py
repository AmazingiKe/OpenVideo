from __future__ import annotations

import asyncio
import traceback

import httpx
import pytest
from agno.agent import Agent
from agno.exceptions import (
    ContextWindowExceededError,
    ModelAuthenticationError,
    ModelProviderError,
    ModelRateLimitError,
)
from agno.models.deepseek import DeepSeek
from agno.models.message import Message
from agno.models.response import ModelResponse
from agno.run.agent import RunErrorEvent
from openai import AsyncOpenAI

from openvideo.core.ai_models import AiModelConfiguration
from openvideo.llm.agno_session_context import AgnoSessionContext
from openvideo.llm.credential_safe_deepseek import CredentialSafeDeepSeek
from openvideo.llm.credentials import resolve_model_api_key


DUMMY_API_KEY = "dummy-credential-safe-deepseek-key"


@pytest.fixture
def model() -> CredentialSafeDeepSeek:
    configuration = AiModelConfiguration(
        name="测试模型",
        litellm_model="deepseek/deepseek-chat",
        api_key=DUMMY_API_KEY,
    )
    return CredentialSafeDeepSeek(
        id="deepseek-chat",
        api_key=resolve_model_api_key(configuration),
        retries=0,
    )


def assert_redacted(error: Exception) -> None:
    assert DUMMY_API_KEY not in str(error)
    assert DUMMY_API_KEY not in repr(error.args)
    assert DUMMY_API_KEY not in "".join(traceback.format_exception(error))
    assert "[已隐藏]" in str(error)
    assert error.__cause__ is None


@pytest.mark.parametrize(
    "error",
    [
        ModelProviderError(f"provider rejected {DUMMY_API_KEY}", status_code=503),
        ModelRateLimitError(f"rate limit {DUMMY_API_KEY}", model_id="deepseek-chat"),
        ContextWindowExceededError(f"context window {DUMMY_API_KEY}"),
        ModelAuthenticationError(f"authentication failed {DUMMY_API_KEY}"),
    ],
)
def test_invoke_redacts_errors_without_changing_sdk_classification(
    model, monkeypatch, error
):
    original_type = type(error)
    original_status = error.status_code
    original_error_id = error.error_id
    error.retry_after_seconds = 3

    def fail(*_args, **_kwargs):
        raise error from RuntimeError(f"raw cause {DUMMY_API_KEY}")

    monkeypatch.setattr(DeepSeek, "invoke", fail)
    with pytest.raises(original_type) as caught:
        model.invoke([], Message(role="assistant"))

    assert caught.value is error
    assert error.status_code == original_status
    assert error.error_id == original_error_id
    assert error.retry_after_seconds == 3
    assert_redacted(error)


@pytest.mark.asyncio
async def test_ainvoke_redacts_summary_request_failure(model, monkeypatch):
    async def fail(*_args, **_kwargs):
        raise ModelProviderError(f"summary failed {DUMMY_API_KEY}", status_code=429)

    monkeypatch.setattr(DeepSeek, "ainvoke", fail)
    with pytest.raises(ModelProviderError) as caught:
        await model.ainvoke([], Message(role="assistant"))

    assert caught.value.status_code == 429
    assert_redacted(caught.value)


def test_invoke_stream_redacts_failure_after_a_chunk(model, monkeypatch):
    first_response = ModelResponse(content="first")

    def fail_after_chunk(*_args, **_kwargs):
        yield first_response
        raise ModelProviderError(f"stream failed {DUMMY_API_KEY}", status_code=503)

    monkeypatch.setattr(DeepSeek, "invoke_stream", fail_after_chunk)
    stream = model.invoke_stream([], Message(role="assistant"))
    assert next(stream) is first_response
    with pytest.raises(ModelProviderError) as caught:
        next(stream)

    assert caught.value.status_code == 503
    assert_redacted(caught.value)


@pytest.mark.asyncio
async def test_ainvoke_stream_redacts_failure_after_a_chunk(model, monkeypatch):
    first_response = ModelResponse(content="first")

    async def fail_after_chunk(*_args, **_kwargs):
        yield first_response
        raise ModelProviderError(f"stream failed {DUMMY_API_KEY}", status_code=401)

    monkeypatch.setattr(DeepSeek, "ainvoke_stream", fail_after_chunk)
    stream = model.ainvoke_stream([], Message(role="assistant"))
    assert await anext(stream) is first_response
    with pytest.raises(ModelProviderError) as caught:
        await anext(stream)

    assert caught.value.status_code == 401
    assert_redacted(caught.value)


def test_unexpected_error_is_redacted_and_keeps_model_identity(model, monkeypatch):
    def fail(*_args, **_kwargs):
        raise RuntimeError(f"unexpected {DUMMY_API_KEY}")

    monkeypatch.setattr(DeepSeek, "invoke", fail)
    with pytest.raises(ModelProviderError) as caught:
        model.invoke([], Message(role="assistant"))

    assert caught.value.model_name == model.name
    assert caught.value.model_id == model.id
    assert_redacted(caught.value)


@pytest.mark.asyncio
async def test_cancellation_keeps_its_control_flow(model, monkeypatch):
    async def cancel(*_args, **_kwargs):
        raise asyncio.CancelledError

    monkeypatch.setattr(DeepSeek, "ainvoke", cancel)
    with pytest.raises(asyncio.CancelledError):
        await model.ainvoke([], Message(role="assistant"))


@pytest.mark.asyncio
async def test_closing_async_stream_closes_provider_stream(model, monkeypatch):
    closed = False

    async def stream_responses(*_args, **_kwargs):
        nonlocal closed
        try:
            yield ModelResponse(content="first")
            yield ModelResponse(content="second")
        finally:
            closed = True

    monkeypatch.setattr(DeepSeek, "ainvoke_stream", stream_responses)
    stream = model.ainvoke_stream([], Message(role="assistant"))
    assert (await anext(stream)).content == "first"
    await stream.aclose()
    assert closed


@pytest.mark.asyncio
async def test_real_agno_failure_is_redacted_before_session_storage(
    model, tmp_path, capsys
):
    def reject_request(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == f"Bearer {DUMMY_API_KEY}"
        return httpx.Response(
            401,
            json={"error": {"message": f"invalid credential {DUMMY_API_KEY}"}},
        )

    context = AgnoSessionContext(tmp_path / "agent-context.sqlite3")
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(reject_request)
    ) as client:
        model.async_client = AsyncOpenAI(
            api_key=DUMMY_API_KEY,
            base_url="https://api.deepseek.com",
            http_client=client,
            max_retries=0,
        )
        agent = Agent(
            id="credential-test",
            model=model,
            db=context.database,
            session_id="credential-test-session",
            telemetry=False,
        )
        events = [
            event async for event in agent.arun("测试", stream=True, stream_events=True)
        ]
        session = await context.database.get_session("credential-test-session")
        await context.database.close()

    errors = [event for event in events if isinstance(event, RunErrorEvent)]
    assert len(errors) == 1
    assert "[已隐藏]" in errors[0].content
    assert DUMMY_API_KEY not in errors[0].content
    assert session is not None
    assert DUMMY_API_KEY not in str(session.to_dict())
    assert "[已隐藏]" in str(session.to_dict())
    captured = capsys.readouterr()
    assert DUMMY_API_KEY not in captured.out + captured.err
