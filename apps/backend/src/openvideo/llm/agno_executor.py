from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from typing import Any, Protocol, cast

from agno.agent import Agent
from agno.models.message import Message
from agno.run.agent import (
    ReasoningStepEvent,
    RunCancelledEvent,
    RunCompletedEvent,
    RunContentEvent,
    RunErrorEvent,
    RunOutputEvent,
    ToolCallCompletedEvent,
    ToolCallStartedEvent,
)
from agno.tools.function import Function

from openvideo.core.agent_runtime_models import AgentDefinition, AgentToolCall
from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.identifiers import uuid7
from openvideo.llm.errors import (
    FeatureCombinationUnsupportedError,
    ProviderRequestError,
    classify_provider_error,
)
from openvideo.llm.events import (
    AgentExecutionResult,
    LlmAgentEvent,
    LlmAgentEventType,
)
from openvideo.llm.model_factory import agent_tool_choice, create_agent_model
from openvideo.llm.model_profile import ModelProfile


AgnoEventHandler = Callable[[LlmAgentEvent], None]


class AgentToolProvider(Protocol):
    def schemas(self, allowed_tools: tuple[str, ...]) -> list[dict[str, Any]]: ...

    async def execute(
        self,
        call: AgentToolCall,
        allowed_tools: tuple[str, ...],
        timeout_seconds: float,
    ) -> dict[str, Any]: ...


class AgentExecutor(Protocol):
    async def run(
        self,
        model: AiModelConfiguration,
        profile: ModelProfile,
        definition: AgentDefinition,
        messages: list[dict[str, Any]],
        registry: AgentToolProvider,
        on_event: AgnoEventHandler,
        *,
        max_tool_calls: int,
        tool_timeout_seconds: float,
    ) -> AgentExecutionResult: ...


class AgnoAgentExecutor:
    """Agno 独占 Provider 消息、流式工具拼包和模型工具循环。"""

    async def run(
        self,
        model: AiModelConfiguration,
        profile: ModelProfile,
        definition: AgentDefinition,
        messages: list[dict[str, Any]],
        registry: AgentToolProvider,
        on_event: AgnoEventHandler,
        *,
        max_tool_calls: int,
        tool_timeout_seconds: float,
    ) -> AgentExecutionResult:
        return await self._run_once(
            model,
            profile,
            definition,
            messages,
            registry,
            on_event,
            max_tool_calls=max_tool_calls,
            tool_timeout_seconds=tool_timeout_seconds,
            reasoning_enabled=False,
        )

    async def _run_once(
        self,
        model: AiModelConfiguration,
        profile: ModelProfile,
        definition: AgentDefinition,
        messages: list[dict[str, Any]],
        registry: AgentToolProvider,
        on_event: AgnoEventHandler,
        *,
        max_tool_calls: int,
        tool_timeout_seconds: float,
        reasoning_enabled: bool,
    ) -> AgentExecutionResult:
        agno_tools = self._tools(registry, definition, tool_timeout_seconds)
        agno_model = create_agent_model(
            model, profile, reasoning_enabled=reasoning_enabled
        )
        agent = Agent(
            id=definition.agent_id,
            model=agno_model,
            instructions=definition.prompt,
            tools=agno_tools,
            tool_choice=(
                agent_tool_choice(profile, reasoning_enabled=reasoning_enabled)
                if agno_tools
                else None
            ),
            tool_call_limit=max_tool_calls,
            retries=0,
            telemetry=False,
        )
        agno_messages = [_message(value) for value in messages]
        try:
            stream = cast(
                AsyncIterator[RunOutputEvent],
                agent.arun(
                    agno_messages,
                    stream=True,
                    stream_events=True,
                ),
            )
            return await self._consume(stream, on_event)
        except asyncio.CancelledError:
            raise
        except (FeatureCombinationUnsupportedError, ProviderRequestError):
            raise
        except Exception as error:
            raise classify_provider_error(error) from error

    @staticmethod
    def _tools(
        registry: AgentToolProvider,
        definition: AgentDefinition,
        timeout_seconds: float,
    ) -> list[Function]:
        functions: list[Function] = []
        for schema in registry.schemas(definition.allowed_tools):
            function_schema = schema["function"]
            name = str(function_schema["name"])

            async def execute_tool(
                _tool_name: str = name,
                **arguments: Any,
            ) -> str:
                result = await registry.execute(
                    AgentToolCall(
                        call_id=f"tool-{uuid7().hex}",
                        name=_tool_name,
                        arguments=arguments,
                    ),
                    definition.allowed_tools,
                    timeout_seconds,
                )
                return json.dumps(result, ensure_ascii=False)

            functions.append(
                Function(
                    name=name,
                    description=str(function_schema["description"]),
                    parameters=cast(dict[str, Any], function_schema["parameters"]),
                    entrypoint=execute_tool,
                    skip_entrypoint_processing=True,
                )
            )
        return functions

    @staticmethod
    async def _consume(
        stream: AsyncIterator[RunOutputEvent], on_event: AgnoEventHandler
    ) -> AgentExecutionResult:
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        successful_tools: set[str] = set()
        async for event in stream:
            if isinstance(event, RunContentEvent):
                if isinstance(event.content, str) and event.content:
                    content_parts.append(event.content)
                    on_event(
                        LlmAgentEvent(
                            event_type=LlmAgentEventType.TEXT_DELTA,
                            content=event.content,
                        )
                    )
                if event.reasoning_content:
                    reasoning_parts.append(event.reasoning_content)
                    on_event(
                        LlmAgentEvent(
                            event_type=LlmAgentEventType.REASONING_DELTA,
                            content=event.reasoning_content,
                        )
                    )
            elif isinstance(event, ReasoningStepEvent):
                if event.reasoning_content:
                    reasoning_parts.append(event.reasoning_content)
                    on_event(
                        LlmAgentEvent(
                            event_type=LlmAgentEventType.REASONING_DELTA,
                            content=event.reasoning_content,
                        )
                    )
            elif isinstance(event, ToolCallStartedEvent) and event.tool is not None:
                on_event(
                    LlmAgentEvent(
                        event_type=LlmAgentEventType.TOOL_CALL_STARTED,
                        call_id=event.tool.tool_call_id,
                        name=event.tool.tool_name,
                        arguments=event.tool.tool_args or {},
                    )
                )
            elif isinstance(event, ToolCallCompletedEvent) and event.tool is not None:
                result = _tool_result(event.tool.result)
                failed = event.tool.tool_call_error is True or result.get("ok") is False
                if not failed and event.tool.tool_name:
                    successful_tools.add(event.tool.tool_name)
                on_event(
                    LlmAgentEvent(
                        event_type=LlmAgentEventType.TOOL_CALL_COMPLETED,
                        call_id=event.tool.tool_call_id,
                        name=event.tool.tool_name,
                        result=result,
                        failed=failed,
                    )
                )
            elif isinstance(event, RunErrorEvent):
                raise classify_provider_error(
                    ProviderRequestError(event.content or "Agno Agent 运行失败")
                )
            elif isinstance(event, RunCancelledEvent):
                raise asyncio.CancelledError
            elif isinstance(event, RunCompletedEvent):
                on_event(
                    LlmAgentEvent(
                        event_type=LlmAgentEventType.RESPONSE_COMPLETED,
                        content="" if event.content is None else str(event.content),
                    )
                )
        return AgentExecutionResult(
            content="".join(content_parts),
            reasoning_content="".join(reasoning_parts),
            successful_tools=successful_tools,
        )


def _message(value: dict[str, Any]) -> Message:
    return Message(
        role=str(value["role"]),
        content=value.get("content"),
        tool_call_id=value.get("tool_call_id"),
        tool_calls=value.get("tool_calls"),
    )


def _tool_result(value: str | None) -> dict[str, Any]:
    if value is None:
        return {"ok": True, "result": None}
    try:
        result = json.loads(value)
    except json.JSONDecodeError:
        return {"ok": True, "result": value}
    return result if isinstance(result, dict) else {"ok": True, "result": result}
