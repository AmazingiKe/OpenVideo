from __future__ import annotations

import litellm

from openvideo.core.ai_models import AiModelConfiguration


class LlmCompletionError(RuntimeError):
    """统一供应商异常与空响应，避免领域工具依赖 LiteLLM 的响应细节。"""


def complete_text(
    model: AiModelConfiguration,
    messages: list[dict[str, object]],
    timeout_seconds: int,
) -> str:
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

    try:
        response = litellm.completion(**request)
        content = response.choices[0].message.content
    except Exception as error:
        raise LlmCompletionError(f"模型请求失败：{error}") from error
    if not isinstance(content, str) or not content.strip():
        raise LlmCompletionError("模型未返回有效文本")
    return content.strip()
