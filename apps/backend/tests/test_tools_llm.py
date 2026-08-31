import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from threading import Lock
from types import SimpleNamespace

import pytest
from PIL import Image

from openvideo.core.ai_models import AiModelConfiguration
from openvideo.tools import llm


MODEL_ID = "model-01890f4c7a2b7cc298c4dc0c0c07398f"


@pytest.fixture(autouse=True)
def clear_vision_transport_cache():
    with llm._vision_transport_lock:
        llm._vision_transport_models.clear()
        llm._vision_transport_key_locks.clear()
    yield
    with llm._vision_transport_lock:
        llm._vision_transport_models.clear()
        llm._vision_transport_key_locks.clear()


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


def test_image_probe_requires_pixel_semantics(monkeypatch):
    captured: dict[str, object] = {}
    challenges = [
        ("data:image/png;base64,first", "LEFT_RED_CENTER_GREEN_RIGHT_BLUE"),
        ("data:image/png;base64,second", "LEFT_CYAN_CENTER_YELLOW_RIGHT_MAGENTA"),
    ]

    def completion(**request):
        captured.update(request)
        message = SimpleNamespace(
            content=(
                "Pixels checked:\n"
                "**A = LEFT_RED_CENTER_GREEN_RIGHT_BLUE**\n"
                "**B=LEFT_CYAN_CENTER_YELLOW_RIGHT_MAGENTA**"
            )
        )
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    monkeypatch.setattr(llm.litellm, "completion", completion)
    monkeypatch.setattr(llm, "_vision_probe_challenges", lambda: challenges)

    model = AiModelConfiguration(
        model_id=MODEL_ID,
        name="视觉模型",
        litellm_model="openai/vision-model",
    )
    llm.probe_image_input(model, timeout_seconds=30)

    content = captured["messages"][0]["content"]
    assert content[2]["image_url"]["url"] == challenges[0][0]
    assert content[4]["image_url"]["url"] == challenges[1][0]
    assert captured["max_tokens"] == llm.VISION_PROBE_MAX_TOKENS
    assert llm.resolved_image_transport_model(model) == "openai/vision-model"

    llm.probe_image_input(model, timeout_seconds=30)

    assert captured["model"] == "openai/vision-model"


def test_deepseek_image_uses_openai_compatible_transport(monkeypatch):
    captured: list[dict[str, object]] = []
    challenges = [
        ("data:image/png;base64,first", "LEFT_RED_CENTER_GREEN_RIGHT_BLUE"),
        ("data:image/png;base64,second", "LEFT_CYAN_CENTER_YELLOW_RIGHT_MAGENTA"),
    ]

    def completion(**request):
        captured.append(request)
        if request["model"].startswith("deepseek/"):
            content = "No image provided"
        else:
            content = (
                "A=LEFT_RED_CENTER_GREEN_RIGHT_BLUE\n"
                "B=LEFT_CYAN_CENTER_YELLOW_RIGHT_MAGENTA"
            )
        message = SimpleNamespace(content=content)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    monkeypatch.setattr(llm.litellm, "completion", completion)
    monkeypatch.setattr(llm, "_vision_probe_challenges", lambda: challenges)

    model = AiModelConfiguration(
        model_id=MODEL_ID,
        name="DeepSeek 视觉模型",
        litellm_model="deepseek/deepseek-v4-flash-vision-exp",
        api_base="https://api.deepseek.com",
        api_key="secret",
        input_modalities=["text", "image"],
    )
    llm.probe_image_input(model, timeout_seconds=30)
    llm.probe_image_input(model, timeout_seconds=30)

    assert [request["model"] for request in captured] == [
        "deepseek/deepseek-v4-flash-vision-exp",
        "openai/deepseek-v4-flash-vision-exp",
    ]
    assert captured[1]["extra_body"] == {"thinking": {"type": "disabled"}}
    assert "thinking" not in captured[1]
    assert llm.resolved_image_transport_model(model) == (
        "openai/deepseek-v4-flash-vision-exp"
    )

    response = llm.complete_text(
        model,
        [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "描述图片"},
                    {
                        "type": "image_url",
                        "image_url": {"url": "data:image/png;base64,image"},
                    },
                ],
            }
        ],
        timeout_seconds=30,
    )

    assert response.startswith("A=LEFT_RED")
    assert captured[-1]["model"] == "openai/deepseek-v4-flash-vision-exp"


def test_image_probe_does_not_hide_authentication_failure(monkeypatch):
    attempted_models: list[str] = []

    def completion(**request):
        attempted_models.append(request["model"])
        raise RuntimeError("invalid api key")

    monkeypatch.setattr(llm.litellm, "completion", completion)
    model = AiModelConfiguration(
        model_id=MODEL_ID,
        name="认证失败模型",
        litellm_model="custom/vision-model",
        api_base="https://api.example.com/v1",
        api_key="invalid",
        input_modalities=["text", "image"],
    )

    with pytest.raises(llm.LlmCompletionError, match="invalid api key"):
        llm.probe_image_input(model, timeout_seconds=30)

    assert attempted_models == ["custom/vision-model"]


def test_image_probe_falls_back_after_content_format_failure(monkeypatch):
    attempted_models: list[str] = []
    challenges = [
        ("data:image/png;base64,first", "LEFT_RED_CENTER_GREEN_RIGHT_BLUE"),
        ("data:image/png;base64,second", "LEFT_CYAN_CENTER_YELLOW_RIGHT_MAGENTA"),
    ]

    def completion(**request):
        attempted_models.append(request["model"])
        if request["model"] == "custom/vision-model":
            raise RuntimeError("content must be a string")
        message = SimpleNamespace(
            content=(
                "A=LEFT_RED_CENTER_GREEN_RIGHT_BLUE\n"
                "B=LEFT_CYAN_CENTER_YELLOW_RIGHT_MAGENTA"
            )
        )
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    monkeypatch.setattr(llm.litellm, "completion", completion)
    monkeypatch.setattr(llm, "_vision_probe_challenges", lambda: challenges)
    model = AiModelConfiguration(
        model_id=MODEL_ID,
        name="兼容网关模型",
        litellm_model="custom/vision-model",
        api_base="https://api.example.com/v1",
        api_key="secret",
        input_modalities=["text", "image"],
    )

    llm.probe_image_input(model, timeout_seconds=30)

    assert attempted_models == ["custom/vision-model", "openai/vision-model"]
    assert llm.resolved_image_transport_model(model) == "openai/vision-model"
    changed_credentials = model.model_copy(update={"api_key": "other-secret"})
    assert llm.resolved_image_transport_model(changed_credentials) == (
        "custom/vision-model"
    )


def test_image_probe_supports_unprefixed_custom_gateway_model(monkeypatch):
    attempted_models: list[str] = []

    def completion(**request):
        attempted_models.append(request["model"])
        if request["model"] == "vision-model":
            raise RuntimeError("unsupported content list")
        message = SimpleNamespace(
            content=(
                "A=LEFT_RED_CENTER_GREEN_RIGHT_BLUE\n"
                "B=LEFT_CYAN_CENTER_YELLOW_RIGHT_MAGENTA"
            )
        )
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    monkeypatch.setattr(llm.litellm, "completion", completion)
    monkeypatch.setattr(
        llm,
        "_vision_probe_challenges",
        lambda: [
            ("data:image/png;base64,first", "LEFT_RED_CENTER_GREEN_RIGHT_BLUE"),
            (
                "data:image/png;base64,second",
                "LEFT_CYAN_CENTER_YELLOW_RIGHT_MAGENTA",
            ),
        ],
    )
    model = AiModelConfiguration(
        model_id=MODEL_ID,
        name="无前缀模型",
        litellm_model="vision-model",
        api_base="https://api.example.com/v1",
        api_key="secret",
        input_modalities=["text", "image"],
    )

    llm.probe_image_input(model, timeout_seconds=30)

    assert attempted_models == ["vision-model", "openai/vision-model"]


def test_concurrent_image_probes_share_one_provider_request(monkeypatch):
    call_count = 0
    count_lock = Lock()
    challenges = [
        ("data:image/png;base64,first", "LEFT_RED_CENTER_GREEN_RIGHT_BLUE"),
        ("data:image/png;base64,second", "LEFT_CYAN_CENTER_YELLOW_RIGHT_MAGENTA"),
    ]

    def completion(**_request):
        nonlocal call_count
        with count_lock:
            call_count += 1
        message = SimpleNamespace(
            content=(
                "A=LEFT_RED_CENTER_GREEN_RIGHT_BLUE\n"
                "B=LEFT_CYAN_CENTER_YELLOW_RIGHT_MAGENTA"
            )
        )
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    monkeypatch.setattr(llm.litellm, "completion", completion)
    monkeypatch.setattr(llm, "_vision_probe_challenges", lambda: challenges)
    model = AiModelConfiguration(
        model_id=MODEL_ID,
        name="并发视觉模型",
        litellm_model="openai/vision-model",
        api_key="secret",
        input_modalities=["text", "image"],
    )

    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(
            executor.map(lambda _: llm.probe_image_input(model, 30), range(4))
        )

    assert results == [None, None, None, None]
    assert call_count == 1


def test_deepseek_text_keeps_native_transport(monkeypatch):
    captured: dict[str, object] = {}

    def completion(**request):
        captured.update(request)
        message = SimpleNamespace(content="完成")
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    monkeypatch.setattr(llm.litellm, "completion", completion)

    llm.complete_text(
        AiModelConfiguration(
            model_id=MODEL_ID,
            name="DeepSeek 文本模型",
            litellm_model="deepseek/deepseek-v4-flash-vision-exp",
            api_base="https://api.deepseek.com",
            api_key="secret",
        ),
        [{"role": "user", "content": "测试文本"}],
        timeout_seconds=30,
        disable_thinking=True,
    )

    assert captured["model"] == "deepseek/deepseek-v4-flash-vision-exp"
    assert captured["thinking"] == {"type": "disabled"}
    assert "extra_body" not in captured


def test_image_probe_rejects_model_that_ignores_pixels(monkeypatch):
    def completion(**_request):
        message = SimpleNamespace(content="No image provided")
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    monkeypatch.setattr(llm.litellm, "completion", completion)
    model = AiModelConfiguration(
        model_id=MODEL_ID,
        name="伪视觉模型",
        litellm_model="openai/text-model",
    )

    with pytest.raises(llm.LlmCompletionError, match="未能读取测试图片"):
        llm.probe_image_input(model, timeout_seconds=30)


def test_image_probe_png_contains_requested_color_stripes():
    data_url = llm._vision_probe_data_url(
        (
            llm.VISION_PROBE_COLORS["RED"],
            llm.VISION_PROBE_COLORS["GREEN"],
            llm.VISION_PROBE_COLORS["BLUE"],
        )
    )
    encoded = data_url.split(",", 1)[1]
    image = Image.open(BytesIO(base64.b64decode(encoded)))

    assert image.size == (
        llm.VISION_PROBE_IMAGE_WIDTH,
        llm.VISION_PROBE_IMAGE_HEIGHT,
    )
    center_y = llm.VISION_PROBE_IMAGE_HEIGHT // 2
    stripe_center = llm.VISION_PROBE_STRIPE_WIDTH // 2
    assert image.getpixel((stripe_center, center_y)) == (
        llm.VISION_PROBE_COLORS["RED"]
    )
    assert image.getpixel(
        (llm.VISION_PROBE_STRIPE_WIDTH + stripe_center, center_y)
    ) == llm.VISION_PROBE_COLORS["GREEN"]
    assert image.getpixel(
        (2 * llm.VISION_PROBE_STRIPE_WIDTH + stripe_center, center_y)
    ) == llm.VISION_PROBE_COLORS["BLUE"]
