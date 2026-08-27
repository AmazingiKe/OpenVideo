from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import litellm

from openvideo.agent_runtime import AgentCapabilityError
from openvideo.core.agent_runtime_models import (
    AgentModelResponse,
    AgentToolCall,
)
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

    try:
        response = litellm.completion(**request)
        content = response.choices[0].message.content
    except litellm.exceptions.ContextWindowExceededError as error:
        raise LlmContextLengthError(f"模型上下文不足：{error}") from error
    except Exception as error:
        raise LlmCompletionError(f"模型请求失败：{error}") from error
    if not isinstance(content, str) or not content.strip():
        raise LlmCompletionError("模型未返回有效文本")
    return content.strip()


AGENT_TIMEOUT_SECONDS = 120
AGENT_MAX_TOKENS = 12_000


class LiteLlmAgentAdapter:
    """使用供应商原生流式工具调用；协议不满足时明确失败。"""

    async def complete(
        self,
        model: AiModelConfiguration,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        on_chunk: Callable[[str], None],
    ) -> AgentModelResponse:
        if tools and not supports_tool_calling(model):
            raise AgentCapabilityError("当前模型不支持 Agent 所需的工具调用")
        try:
            return await self._request(model, messages, tools, on_chunk)
        except Exception as error:
            if tools and _is_tool_parameter_rejection(error):
                raise AgentCapabilityError(f"模型服务拒绝工具协议：{error}") from error
            raise LlmCompletionError(f"模型请求失败：{error}") from error

    async def _request(
        self,
        model: AiModelConfiguration,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        on_chunk: Callable[[str], None],
    ) -> AgentModelResponse:
        request: dict[str, Any] = {
            "model": model.litellm_model,
            "messages": messages,
            "timeout": AGENT_TIMEOUT_SECONDS,
            "max_tokens": AGENT_MAX_TOKENS,
            "stream": True,
            "thinking": {"type": "disabled"},
        }
        if model.api_key:
            request["api_key"] = model.api_key
        if model.api_base:
            request["api_base"] = model.api_base
        if model.api_version:
            request["api_version"] = model.api_version
        if tools:
            request["tools"] = tools
            request["tool_choice"] = "auto"

        stream = await litellm.acompletion(**request)
        content_parts: list[str] = []
        tool_fragments: dict[int, dict[str, str]] = {}
        async for chunk in stream:
            delta = chunk.choices[0].delta
            content = getattr(delta, "content", None)
            if isinstance(content, str) and content:
                content_parts.append(content)
                on_chunk(content)
            for tool_call in getattr(delta, "tool_calls", None) or []:
                index = int(getattr(tool_call, "index", 0))
                fragment = tool_fragments.setdefault(
                    index, {"id": "", "name": "", "arguments": ""}
                )
                call_id = getattr(tool_call, "id", None)
                if call_id:
                    fragment["id"] += call_id
                function = getattr(tool_call, "function", None)
                if function is not None:
                    name = getattr(function, "name", None)
                    arguments = getattr(function, "arguments", None)
                    if name:
                        fragment["name"] += name
                    if arguments:
                        fragment["arguments"] += arguments
        calls: list[AgentToolCall] = []
        for index in sorted(tool_fragments):
            fragment = tool_fragments[index]
            try:
                arguments = json.loads(fragment["arguments"] or "{}")
            except json.JSONDecodeError:
                arguments = {"_invalid_json": fragment["arguments"]}
            calls.append(
                AgentToolCall(
                    call_id=fragment["id"] or f"tool-{index}",
                    name=fragment["name"],
                    arguments=arguments,
                )
            )
        return AgentModelResponse(content="".join(content_parts), tool_calls=calls)


def supports_tool_calling(model: AiModelConfiguration) -> bool:
    if model.tool_calling_mode == "enabled":
        return True
    if model.tool_calling_mode == "disabled":
        return False
    try:
        return bool(litellm.supports_function_calling(model=model.litellm_model))
    except Exception:
        return False


def probe_tool_calling(
    model: AiModelConfiguration,
    timeout_seconds: int,
) -> None:
    """要求供应商实际返回函数调用，避免仅凭模型名称推测 Agent 能力。"""

    request: dict[str, Any] = {
        "model": model.litellm_model,
        "messages": [
            {
                "role": "user",
                "content": "Call report_probe with status set to ok.",
            }
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "report_probe",
                    "description": "Report the model capability probe result.",
                    "parameters": {
                        "type": "object",
                        "properties": {"status": {"type": "string", "enum": ["ok"]}},
                        "required": ["status"],
                        "additionalProperties": False,
                    },
                },
            }
        ],
        "tool_choice": {
            "type": "function",
            "function": {"name": "report_probe"},
        },
        "timeout": timeout_seconds,
        "max_tokens": 32,
    }
    if model.api_key:
        request["api_key"] = model.api_key
    if model.api_base:
        request["api_base"] = model.api_base
    if model.api_version:
        request["api_version"] = model.api_version
    try:
        response = litellm.completion(**request)
        tool_calls = getattr(response.choices[0].message, "tool_calls", None)
    except Exception as error:
        raise LlmCompletionError(f"工具调用探测失败：{error}") from error
    if not tool_calls:
        raise LlmCompletionError("工具调用探测失败：模型未返回工具调用")


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


def _is_tool_parameter_rejection(error: Exception) -> bool:
    message = str(error).lower()
    return any(
        marker in message
        for marker in (
            "tool",
            "function calling",
            "tool_choice",
            "unsupported parameter",
        )
    )
