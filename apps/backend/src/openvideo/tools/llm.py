from __future__ import annotations

import asyncio
import base64
import secrets
import struct
import zlib

import litellm

from openvideo.core.ai_models import (
    AiModelConfiguration,
    online_api_configuration_error,
)
from openvideo.llm.errors import (
    MAX_PROVIDER_REQUEST_RETRIES,
    TransientProviderRequestError,
    classify_provider_error,
    provider_retry_delay_seconds,
)
from openvideo.llm.request_scheduler import (
    ModelRequestPriority,
    defer_model_requests,
    model_request_slot,
    model_request_slot_async,
)


class LlmCompletionError(RuntimeError):
    """统一供应商异常与空响应，避免领域工具依赖 LiteLLM 的响应细节。"""


class LlmContextLengthError(LlmCompletionError):
    """输入超过模型上下文时保留可恢复语义，供 Agent 请求用户决策。"""


VISION_PROBE_COLORS = {
    "RED": (255, 0, 0),
    "GREEN": (0, 180, 0),
    "BLUE": (0, 0, 255),
    "YELLOW": (255, 220, 0),
    "MAGENTA": (255, 0, 255),
    "CYAN": (0, 220, 220),
}
VISION_PROBE_IMAGE_WIDTH = 72
VISION_PROBE_IMAGE_HEIGHT = 32
VISION_PROBE_STRIPE_COUNT = 3
VISION_PROBE_STRIPE_WIDTH = VISION_PROBE_IMAGE_WIDTH // VISION_PROBE_STRIPE_COUNT
VISION_PROBE_MAX_TOKENS = 64
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_BIT_DEPTH = 8
PNG_COLOR_TYPE_RGB = 2
VISION_PROBE_PROMPT = (
    "Two images labeled A and B each contain three equal solid-color vertical "
    "stripes. Read the actual pixels. Reply with exactly two lines in this format: "
    "A=LEFT_<COLOR>_CENTER_<COLOR>_RIGHT_<COLOR> and "
    "B=LEFT_<COLOR>_CENTER_<COLOR>_RIGHT_<COLOR>. Use only RED, GREEN, BLUE, "
    "YELLOW, MAGENTA, or CYAN."
)
VISION_PROBE_LABELS = ("A", "B")
DEEPSEEK_PROVIDER_PREFIX = "deepseek/"
OPENAI_COMPATIBLE_PROVIDER_PREFIX = "openai/"


def complete_text(
    model: AiModelConfiguration,
    messages: list[dict[str, object]],
    timeout_seconds: int,
    max_tokens: int | None = None,
    disable_thinking: bool = False,
    priority: ModelRequestPriority = ModelRequestPriority.BACKGROUND,
) -> str:
    request = _completion_request(
        model,
        messages,
        timeout_seconds,
        max_tokens,
        disable_thinking,
    )
    content = _complete_with_retry(request, priority)
    return _validated_content(content)


async def complete_text_async(
    model: AiModelConfiguration,
    messages: list[dict[str, object]],
    timeout_seconds: int,
    max_tokens: int | None = None,
    disable_thinking: bool = False,
    priority: ModelRequestPriority = ModelRequestPriority.BACKGROUND,
) -> str:
    """异步请求允许任务取消直接传播到底层 HTTP 连接。"""

    request = _completion_request(
        model,
        messages,
        timeout_seconds,
        max_tokens,
        disable_thinking,
    )
    content = await _complete_with_retry_async(request, priority)
    return _validated_content(content)


def _complete_with_retry(
    request: dict[str, object],
    priority: ModelRequestPriority,
) -> object:
    for attempt in range(MAX_PROVIDER_REQUEST_RETRIES + 1):
        try:
            with model_request_slot(priority):
                response = litellm.completion(**request)
            return response.choices[0].message.content
        except litellm.exceptions.ContextWindowExceededError as error:
            raise LlmContextLengthError(f"模型上下文不足：{error}") from error
        except Exception as error:
            classified = classify_provider_error(error)
            if (
                isinstance(classified, TransientProviderRequestError)
                and attempt < MAX_PROVIDER_REQUEST_RETRIES
            ):
                defer_model_requests(
                    provider_retry_delay_seconds(classified, attempt)
                )
                continue
            raise LlmCompletionError(f"模型请求失败：{classified}") from error
    raise AssertionError("模型重试循环必须返回或抛出异常")


async def _complete_with_retry_async(
    request: dict[str, object],
    priority: ModelRequestPriority,
) -> object:
    for attempt in range(MAX_PROVIDER_REQUEST_RETRIES + 1):
        try:
            async with model_request_slot_async(priority):
                response = await litellm.acompletion(**request)
            return response.choices[0].message.content
        except litellm.exceptions.ContextWindowExceededError as error:
            raise LlmContextLengthError(f"模型上下文不足：{error}") from error
        except asyncio.CancelledError:
            raise
        except Exception as error:
            classified = classify_provider_error(error)
            if (
                isinstance(classified, TransientProviderRequestError)
                and attempt < MAX_PROVIDER_REQUEST_RETRIES
            ):
                defer_model_requests(
                    provider_retry_delay_seconds(classified, attempt)
                )
                continue
            raise LlmCompletionError(f"模型请求失败：{classified}") from error
    raise AssertionError("模型重试循环必须返回或抛出异常")


def _completion_request(
    model: AiModelConfiguration,
    messages: list[dict[str, object]],
    timeout_seconds: int,
    max_tokens: int | None,
    disable_thinking: bool,
) -> dict[str, object]:
    configuration_error = online_api_configuration_error(model)
    if configuration_error is not None:
        raise LlmCompletionError(configuration_error)
    deepseek_vision_model = _deepseek_vision_compatibility_model(
        model.litellm_model,
        messages,
    )
    request: dict[str, object] = {
        "model": deepseek_vision_model or model.litellm_model,
        "messages": messages,
        "timeout": timeout_seconds,
    }
    if model.api_key:
        request["api_key"] = model.api_key
    if model.api_base:
        request["api_base"] = model.api_base
    if model.api_version:
        request["api_version"] = model.api_version
    if max_tokens is not None:
        request["max_tokens"] = max_tokens
    if disable_thinking:
        thinking = {"type": "disabled"}
        if deepseek_vision_model is not None:
            request["extra_body"] = {"thinking": thinking}
        else:
            request["thinking"] = thinking
    return request


def _deepseek_vision_compatibility_model(
    litellm_model: str,
    messages: list[dict[str, object]],
) -> str | None:
    """绕过会把 DeepSeek 多模态内容列表降为纯文本的旧传输适配器。"""

    if not litellm_model.startswith(DEEPSEEK_PROVIDER_PREFIX):
        return None
    contains_image = any(
        isinstance(content, list)
        and any(
            isinstance(part, dict) and part.get("type") == "image_url"
            for part in content
        )
        for message in messages
        for content in (message.get("content"),)
    )
    if not contains_image:
        return None
    model_name = litellm_model.removeprefix(DEEPSEEK_PROVIDER_PREFIX)
    return f"{OPENAI_COMPATIBLE_PROVIDER_PREFIX}{model_name}"


def _validated_content(content: object) -> str:
    if not isinstance(content, str) or not content.strip():
        raise LlmCompletionError("模型未返回有效文本")
    return content.strip()


def probe_image_input(
    model: AiModelConfiguration,
    timeout_seconds: int,
) -> None:
    """用两张随机三色图验证模型确实读取像素，而不是只接受请求格式。"""

    challenges = _vision_probe_challenges()
    content: list[dict[str, object]] = [
        {"type": "text", "text": VISION_PROBE_PROMPT}
    ]
    for label, (data_url, _) in zip(VISION_PROBE_LABELS, challenges, strict=True):
        content.extend(
            (
                {"type": "text", "text": f"Image {label}"},
                {"type": "image_url", "image_url": {"url": data_url}},
            )
        )
    response = complete_text(
        model,
        [
            {
                "role": "user",
                "content": content,
            }
        ],
        timeout_seconds=timeout_seconds,
        max_tokens=VISION_PROBE_MAX_TOKENS,
        disable_thinking=True,
        priority=ModelRequestPriority.FOREGROUND,
    )
    expected_lines = [
        f"{label}={answer}"
        for label, (_, answer) in zip(VISION_PROBE_LABELS, challenges, strict=True)
    ]
    normalized_lines = [
        line.strip().upper().strip("` .")
        for line in response.strip().splitlines()
        if line.strip()
    ]
    if normalized_lines != expected_lines:
        raise LlmCompletionError("模型接受了请求，但未能读取测试图片中的颜色")


def _vision_probe_challenges() -> list[tuple[str, str]]:
    random_source = secrets.SystemRandom()
    color_names = tuple(VISION_PROBE_COLORS)
    challenges = []
    for _ in VISION_PROBE_LABELS:
        selected_names = random_source.sample(color_names, 3)
        selected_colors = tuple(VISION_PROBE_COLORS[name] for name in selected_names)
        data_url = _vision_probe_data_url(selected_colors)
        answer = (
            f"LEFT_{selected_names[0]}_CENTER_{selected_names[1]}_"
            f"RIGHT_{selected_names[2]}"
        )
        challenges.append((data_url, answer))
    return challenges


def _vision_probe_data_url(
    colors: tuple[tuple[int, int, int], ...],
) -> str:
    if len(colors) != VISION_PROBE_STRIPE_COUNT:
        raise ValueError("视觉探针必须包含三个颜色条")
    row = b"\x00" + b"".join(
        bytes(color) * VISION_PROBE_STRIPE_WIDTH for color in colors
    )
    pixels = row * VISION_PROBE_IMAGE_HEIGHT
    header = struct.pack(
        ">IIBBBBB",
        VISION_PROBE_IMAGE_WIDTH,
        VISION_PROBE_IMAGE_HEIGHT,
        PNG_BIT_DEPTH,
        PNG_COLOR_TYPE_RGB,
        0,
        0,
        0,
    )
    png = (
        PNG_SIGNATURE
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", zlib.compress(pixels))
        + _png_chunk(b"IEND", b"")
    )
    encoded = base64.b64encode(png).decode()
    return f"data:image/png;base64,{encoded}"


def _png_chunk(chunk_type: bytes, payload: bytes) -> bytes:
    checksum = zlib.crc32(chunk_type + payload) & 0xFFFFFFFF
    return (
        struct.pack(">I", len(payload))
        + chunk_type
        + payload
        + struct.pack(">I", checksum)
    )
