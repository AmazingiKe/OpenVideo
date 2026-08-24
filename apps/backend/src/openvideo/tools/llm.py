from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import litellm

from openvideo.core.agent_runtime_models import (
    AgentModelResponse,
    AgentToolCall,
)
from openvideo.core.ai_models import AiModelConfiguration


class LlmCompletionError(RuntimeError):
    """统一供应商异常与空响应，避免领域工具依赖 LiteLLM 的响应细节。"""


class LlmContextLengthError(LlmCompletionError):
    """输入超过模型上下文时保留可恢复语义，供 Agent 请求用户决策。"""


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
    """只在 Agent 任务中暴露原生工具调用，并保留一次纯聊天降级机会。"""

    async def complete(
        self,
        model: AiModelConfiguration,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        on_chunk: Callable[[str], None],
    ) -> AgentModelResponse:
        supports_tools = _supports_tool_calling(model)
        enabled_tools = tools if supports_tools else []
        try:
            response = await self._request(
                model, messages, enabled_tools, on_chunk
            )
            if tools and not supports_tools:
                return response.model_copy(
                    update={"degraded_reason": "当前模型未启用工具能力，已使用纯聊天"}
                )
            return response
        except Exception as error:
            if not enabled_tools or not _is_tool_parameter_rejection(error):
                raise LlmCompletionError(f"模型请求失败：{error}") from error
            response = await self._request(model, messages, [], on_chunk)
            return response.model_copy(
                update={"degraded_reason": "模型服务拒绝工具参数，已降级为纯聊天"}
            )

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


def _supports_tool_calling(model: AiModelConfiguration) -> bool:
    if model.tool_calling_mode == "enabled":
        return True
    if model.tool_calling_mode == "disabled":
        return False
    try:
        return bool(litellm.supports_function_calling(model=model.litellm_model))
    except Exception:
        return False


def _is_tool_parameter_rejection(error: Exception) -> bool:
    message = str(error).lower()
    return any(
        marker in message
        for marker in ("tool", "function calling", "tool_choice", "unsupported parameter")
    )
