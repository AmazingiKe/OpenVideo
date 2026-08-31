from __future__ import annotations

import asyncio
import base64
import hashlib
import re
import secrets
import struct
from threading import Lock, RLock
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
VISION_PROBE_IMAGE_WIDTH = 384
VISION_PROBE_IMAGE_HEIGHT = 192
VISION_PROBE_STRIPE_COUNT = 3
VISION_PROBE_STRIPE_WIDTH = VISION_PROBE_IMAGE_WIDTH // VISION_PROBE_STRIPE_COUNT
VISION_PROBE_MAX_TOKENS = 256
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
OPENAI_COMPATIBLE_PROVIDER_PREFIX = "openai/"
VISION_TRANSPORT_ERROR_MARKERS = (
    "content list",
    "content must be a string",
    "content should be a string",
    "image input",
    "image_url",
    "multimodal",
    "unsupported content",
)
VISION_PROBE_RESPONSE_PATTERN = re.compile(
    r"\b([AB])\s*=\s*"
    r"(LEFT_(?:RED|GREEN|BLUE|YELLOW|MAGENTA|CYAN)_"
    r"CENTER_(?:RED|GREEN|BLUE|YELLOW|MAGENTA|CYAN)_"
    r"RIGHT_(?:RED|GREEN|BLUE|YELLOW|MAGENTA|CYAN))\b",
)
VisionTransportCacheKey = tuple[str, str, str, str, str]
_vision_transport_models: dict[VisionTransportCacheKey, str] = {}
_vision_transport_key_locks: dict[VisionTransportCacheKey, Lock] = {}
_vision_transport_lock = RLock()


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
    *,
    transport_model: str | None = None,
) -> dict[str, object]:
    configuration_error = online_api_configuration_error(model)
    if configuration_error is not None:
        raise LlmCompletionError(configuration_error)
    selected_model = transport_model or (
        resolved_image_transport_model(model)
        if _messages_contain_images(messages)
        else model.litellm_model
    )
    request: dict[str, object] = {
        "model": selected_model,
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
        if selected_model != model.litellm_model:
            request["extra_body"] = {"thinking": thinking}
        else:
            request["thinking"] = thinking
    return request


def _messages_contain_images(
    messages: list[dict[str, object]],
) -> bool:
    return any(
        isinstance(content, list)
        and any(
            isinstance(part, dict) and part.get("type") == "image_url"
            for part in content
        )
        for message in messages
        for content in (message.get("content"),)
    )


def resolved_image_transport_model(model: AiModelConfiguration) -> str:
    """返回经过真实像素验证的传输模型，尚未验证时保持原生协议。"""

    cache_key = _vision_transport_cache_key(model)
    with _vision_transport_lock:
        return _vision_transport_models.get(cache_key, model.litellm_model)


def _vision_transport_cache_key(
    model: AiModelConfiguration,
) -> VisionTransportCacheKey:
    api_key_digest = hashlib.sha256((model.api_key or "").encode()).hexdigest()
    return (
        model.model_id,
        model.litellm_model,
        model.api_base or "",
        model.api_version or "",
        api_key_digest,
    )


def _vision_transport_key_lock(cache_key: VisionTransportCacheKey) -> Lock:
    with _vision_transport_lock:
        return _vision_transport_key_locks.setdefault(cache_key, Lock())


def _validated_content(content: object) -> str:
    if not isinstance(content, str) or not content.strip():
        raise LlmCompletionError("模型未返回有效文本")
    return content.strip()


def probe_image_input(
    model: AiModelConfiguration,
    timeout_seconds: int,
) -> None:
    """用随机像素协商可读图传输，避免相信声明或接受请求即判定可用。"""

    cache_key = _vision_transport_cache_key(model)
    with _vision_transport_lock:
        if cache_key in _vision_transport_models:
            return
    with _vision_transport_key_lock(cache_key):
        with _vision_transport_lock:
            if cache_key in _vision_transport_models:
                return
        _probe_image_transport(model, timeout_seconds, cache_key)


def _probe_image_transport(
    model: AiModelConfiguration,
    timeout_seconds: int,
    cache_key: VisionTransportCacheKey,
) -> None:
    challenges = _vision_probe_challenges()
    messages = _vision_probe_messages(challenges)
    expected = {
        label: answer
        for label, (_, answer) in zip(VISION_PROBE_LABELS, challenges, strict=True)
    }
    errors: list[tuple[str, LlmCompletionError]] = []
    candidates = _vision_transport_candidates(model)
    for index, transport_model in enumerate(candidates):
        try:
            response = _complete_image_probe(
                model,
                messages,
                timeout_seconds,
                transport_model,
            )
            _validate_image_probe_response(response, expected)
        except LlmCompletionError as error:
            errors.append((transport_model, error))
            has_fallback = index + 1 < len(candidates)
            if has_fallback and _can_retry_with_compatible_transport(error):
                continue
            break
        with _vision_transport_lock:
            _vision_transport_models[cache_key] = transport_model
        return
    if len(errors) == 1:
        raise errors[0][1]
    attempted = "；".join(
        f"{transport}: {error}" for transport, error in errors
    )
    raise LlmCompletionError(f"视觉传输协商失败：{attempted}") from errors[-1][1]


def _vision_transport_candidates(model: AiModelConfiguration) -> list[str]:
    candidates = [model.litellm_model]
    provider, separator, model_name = model.litellm_model.partition("/")
    openai_provider = OPENAI_COMPATIBLE_PROVIDER_PREFIX.removesuffix("/")
    if model.api_base and provider.casefold() != openai_provider:
        compatible_model_name = model_name if separator else provider
        compatible_model = (
            f"{OPENAI_COMPATIBLE_PROVIDER_PREFIX}{compatible_model_name}"
        )
        if compatible_model != model.litellm_model:
            candidates.append(compatible_model)
    return candidates


def _complete_image_probe(
    model: AiModelConfiguration,
    messages: list[dict[str, object]],
    timeout_seconds: int,
    transport_model: str,
) -> str:
    request = _completion_request(
        model,
        messages,
        timeout_seconds,
        VISION_PROBE_MAX_TOKENS,
        True,
        transport_model=transport_model,
    )
    content = _complete_with_retry(request, ModelRequestPriority.FOREGROUND)
    try:
        return _validated_content(content)
    except LlmCompletionError as error:
        raise ImageInputSemanticError("模型未返回可验证的视觉答案") from error


def _can_retry_with_compatible_transport(error: LlmCompletionError) -> bool:
    if isinstance(error, ImageInputSemanticError):
        return True
    normalized_message = str(error).casefold()
    return any(marker in normalized_message for marker in VISION_TRANSPORT_ERROR_MARKERS)


class ImageInputSemanticError(LlmCompletionError):
    """供应商返回了文本，但随机像素证明图片没有进入模型上下文。"""


def _vision_probe_messages(
    challenges: list[tuple[str, str]],
) -> list[dict[str, object]]:
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
    return [{"role": "user", "content": content}]


def _validate_image_probe_response(
    response: str,
    expected: dict[str, str],
) -> None:
    reported = {
        match.group(1): match.group(2)
        for match in VISION_PROBE_RESPONSE_PATTERN.finditer(response.upper())
    }
    if reported != expected:
        raise ImageInputSemanticError(
            "模型接受了请求，但未能读取测试图片中的颜色"
        )


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
