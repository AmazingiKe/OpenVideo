import asyncio
from types import SimpleNamespace

import pytest

from openvideo.core.ai_models import AiModelConfiguration
from openvideo.tools import llm


MODEL_ID = "model-01890f4c7a2b7cc298c4dc0c0c07398f"


@pytest.mark.asyncio
async def test_async_completion_propagates_cancellation(monkeypatch):
    provider_started = asyncio.Event()
    provider_cancelled = asyncio.Event()

    async def pending_completion(**_kwargs):
        provider_started.set()
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            provider_cancelled.set()
            raise

    monkeypatch.setattr(llm.litellm, "acompletion", pending_completion)
    task = asyncio.create_task(
        llm.complete_text_async(
            AiModelConfiguration(
                model_id=MODEL_ID,
                name="可取消模型",
                litellm_model="openai/test-model",
            ),
            [{"role": "user", "content": "测试取消"}],
            timeout_seconds=30,
        )
    )
    await provider_started.wait()

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert provider_cancelled.is_set()


def test_completion_rejects_local_provider_before_network(monkeypatch):
    monkeypatch.setattr(
        llm.litellm,
        "completion",
        lambda **_kwargs: pytest.fail("本地模型不应发起请求"),
    )
    model = AiModelConfiguration(
        model_id=MODEL_ID,
        name="本地模型",
        litellm_model="ollama/qwen2.5-vl",
        api_base="http://127.0.0.1:11434",
    )

    with pytest.raises(llm.LlmCompletionError, match="仅支持在线 API"):
        llm.complete_text(
            model,
            [{"role": "user", "content": "测试"}],
            timeout_seconds=30,
        )


def test_completion_retries_transient_provider_failure(monkeypatch):
    attempts = 0
    delays: list[float] = []

    def completion(**_kwargs):
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise RuntimeError("429 rate limit")
        message = SimpleNamespace(content="完成")
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    monkeypatch.setattr(llm.litellm, "completion", completion)
    monkeypatch.setattr(llm, "defer_model_requests", delays.append)

    content = llm.complete_text(
        AiModelConfiguration(
            model_id=MODEL_ID,
            name="在线模型",
            litellm_model="openai/test-model",
        ),
        [{"role": "user", "content": "测试限流"}],
        timeout_seconds=30,
    )

    assert content == "完成"
    assert attempts == 3
    assert delays == [1.0, 2.0]


def test_completion_does_not_retry_permanent_provider_failure(monkeypatch):
    attempts = 0

    def completion(**_kwargs):
        nonlocal attempts
        attempts += 1
        raise RuntimeError("invalid api key")

    monkeypatch.setattr(llm.litellm, "completion", completion)

    with pytest.raises(llm.LlmCompletionError, match="invalid api key"):
        llm.complete_text(
            AiModelConfiguration(
                model_id=MODEL_ID,
                name="在线模型",
                litellm_model="openai/test-model",
            ),
            [{"role": "user", "content": "测试认证错误"}],
            timeout_seconds=30,
        )

    assert attempts == 1
