from __future__ import annotations

import litellm

from openvideo.core.ai_models import AiModelConfiguration


class LlmCompletionError(RuntimeError):
    """统一供应商异常与空响应，避免领域工具依赖 LiteLLM 的响应细节。"""


class LlmContextLengthError(LlmCompletionError):
    """输入超过模型上下文时保留可恢复语义，供 Agent 请求用户决策。"""


VISION_PROBE_DATA_URL = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUB"
    "AScY42YAAAAASUVORK5CYII="
)


def complete_text(
    model: AiModelConfiguration,
    messages: list[dict[str, object]],
    timeout_seconds: int,
    max_tokens: int | None = None,
    disable_thinking: bool = False,
) -> str:
    request = _completion_request(
        model,
        messages,
        timeout_seconds,
        max_tokens,
        disable_thinking,
    )
    try:
        response = litellm.completion(**request)
        content = response.choices[0].message.content
    except litellm.exceptions.ContextWindowExceededError as error:
        raise LlmContextLengthError(f"模型上下文不足：{error}") from error
    except Exception as error:
        raise LlmCompletionError(f"模型请求失败：{error}") from error
    return _validated_content(content)


async def complete_text_async(
    model: AiModelConfiguration,
    messages: list[dict[str, object]],
    timeout_seconds: int,
    max_tokens: int | None = None,
    disable_thinking: bool = False,
) -> str:
    """异步请求允许任务取消直接传播到底层 HTTP 连接。"""

    request = _completion_request(
        model,
        messages,
        timeout_seconds,
        max_tokens,
        disable_thinking,
    )
    try:
        response = await litellm.acompletion(**request)
        content = response.choices[0].message.content
    except litellm.exceptions.ContextWindowExceededError as error:
        raise LlmContextLengthError(f"模型上下文不足：{error}") from error
    except Exception as error:
        raise LlmCompletionError(f"模型请求失败：{error}") from error
    return _validated_content(content)


def _completion_request(
    model: AiModelConfiguration,
    messages: list[dict[str, object]],
    timeout_seconds: int,
    max_tokens: int | None,
    disable_thinking: bool,
) -> dict[str, object]:
    request: dict[str, object] = {
        "model": model.litellm_model,
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
        request["thinking"] = {"type": "disabled"}
    return request


def _validated_content(content: object) -> str:
    if not isinstance(content, str) or not content.strip():
        raise LlmCompletionError("模型未返回有效文本")
    return content.strip()


def probe_image_input(
    model: AiModelConfiguration,
    timeout_seconds: int,
) -> None:
    """发送最小内嵌图片，验证声明的视觉输入可被供应商协议接受。"""

    complete_text(
        model,
        [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Reply only with OK."},
                    {
                        "type": "image_url",
                        "image_url": {"url": VISION_PROBE_DATA_URL},
                    },
                ],
            }
        ],
        timeout_seconds=timeout_seconds,
        max_tokens=8,
        disable_thinking=True,
    )
