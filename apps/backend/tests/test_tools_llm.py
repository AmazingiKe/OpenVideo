import asyncio

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
