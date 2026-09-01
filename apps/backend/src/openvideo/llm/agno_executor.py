from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from time import monotonic
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

from openvideo.core.agent_runtime_models import AgentDefinition, AgentMode, AgentToolCall
from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.identifiers import uuid7
from openvideo.llm.agno_session_context import (
    AGNO_HISTORY_RUN_COUNT,
    AGNO_HISTORY_TOOL_CALL_LIMIT,
    AgnoSessionContext,
)
from openvideo.llm.errors import (
    FeatureCombinationUnsupportedError,
    MAX_PROVIDER_REQUEST_RETRIES,
    ProviderRequestError,
    TransientProviderRequestError,
    classify_provider_error,
    provider_retry_delay_seconds,
)
from openvideo.llm.events import (
    AgentExecutionResult,
    LlmAgentEvent,
    LlmAgentEventType,
)
from openvideo.llm.model_factory import agent_tool_choice, create_agent_model
from openvideo.llm.model_profile import ModelProfile, Support
from openvideo.llm.request_scheduler import (
    ModelRequestPriority,
    defer_model_requests,
    model_request_slot_async,
)


AgnoEventHandler = Callable[[LlmAgentEvent], None]
STREAM_DELTA_CHARACTER_LIMIT = 256
STREAM_DELTA_INTERVAL_SECONDS = 0.2
TOOL_SEQUENCE_INSTRUCTION = (
    "相同工具和相同参数只允许调用一次；所有工具调用结束后再输出最终正文，"
    "一旦开始输出最终正文就不得继续调用工具。"
)
REQUIRED_TOOL_RECOVERY_INSTRUCTION = (
    "上一步没有完成 Agent 声明的必需工具。不要继续解释过程，也不要普通回答。"
    "先调用尚未完成的前置工具，然后调用必需工具并提交结构化参数。"
)


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
        historical_messages: list[dict[str, Any]] | None = None,
        run_context: str | None = None,
        session_id: str | None = None,
    ) -> AgentExecutionResult: ...


class AgnoAgentExecutor:
    """Agno 独占 Provider 消息、流式工具拼包和模型工具循环。"""

    def __init__(self, session_context: AgnoSessionContext | None = None) -> None:
        self.session_context = session_context

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
        historical_messages: list[dict[str, Any]] | None = None,
        run_context: str | None = None,
        session_id: str | None = None,
    ) -> AgentExecutionResult:
        if self.session_context is not None and session_id is not None:
            await self.session_context.ensure_session(
                session_id,
                definition.agent_id,
                historical_messages or [],
            )
        required_tool_chain = self._required_tool_chain(definition)
        recovery_reserve = min(
            len(required_tool_chain),
            max(0, max_tool_calls - 1),
        )
        first_result = await self._run_once(
            model,
            profile,
            definition,
            messages,
            registry,
            on_event,
            max_tool_calls=max_tool_calls - recovery_reserve,
            tool_timeout_seconds=tool_timeout_seconds,
            reasoning_enabled=False,
            run_context=run_context,
            session_id=session_id,
        )
        missing_tools = definition.required_tools - first_result.successful_tools
        remaining_tool_calls = max_tool_calls - first_result.tool_call_count
        if not missing_tools or remaining_tool_calls <= 0:
            return first_result

        recovery_definition, forced_tool_name = self._recovery_definition(
            definition,
            missing_tools,
            first_result.successful_tools,
            profile,
        )
        recovery_messages: list[dict[str, Any]] = []
        if session_id is None or self.session_context is None:
            recovery_messages = [*messages]
            if first_result.content:
                recovery_messages.append(
                    {"role": "assistant", "content": first_result.content}
                )
        recovery_messages.append(
            {
                "role": "user",
                "content": REQUIRED_TOOL_RECOVERY_INSTRUCTION,
            }
        )
        recovery_result = await self._run_once(
            model,
            profile,
            recovery_definition,
            recovery_messages,
            registry,
            on_event,
            max_tool_calls=remaining_tool_calls,
            tool_timeout_seconds=tool_timeout_seconds,
            reasoning_enabled=False,
            forced_tool_name=forced_tool_name,
            run_context=run_context,
            session_id=session_id,
        )
        return AgentExecutionResult(
            content=recovery_result.content or first_result.content,
            reasoning_content=(
                first_result.reasoning_content + recovery_result.reasoning_content
            ),
            successful_tools=(
                first_result.successful_tools | recovery_result.successful_tools
            ),
            tool_call_count=(
                first_result.tool_call_count + recovery_result.tool_call_count
            ),
            retry_count=first_result.retry_count + recovery_result.retry_count + 1,
        )

    @staticmethod
    def _recovery_definition(
        definition: AgentDefinition,
        missing_tools: set[str],
        successful_tools: set[str],
        profile: ModelProfile,
    ) -> tuple[AgentDefinition, str | None]:
        needed_tools = AgnoAgentExecutor._required_tool_chain(definition, missing_tools)
        remaining_tools = needed_tools - successful_tools
        recovery_tools = [
            tool for tool in definition.tools if tool.name in remaining_tools
        ]
        forced_tool_name = None
        if (
            len(remaining_tools) == 1
            and len(missing_tools) == 1
            and profile.capabilities.tool_choice_named == Support.YES
        ):
            forced_tool_name = next(iter(missing_tools))
        recovery_prompt = (
            f"{definition.prompt}\n\n{REQUIRED_TOOL_RECOVERY_INSTRUCTION} "
            f"本轮必须完成：{', '.join(sorted(missing_tools))}。"
        )
        return (
            definition.model_copy(
                update={
                    "prompt": recovery_prompt,
                    "tools": recovery_tools,
                    "required_tools": missing_tools,
                }
            ),
            forced_tool_name,
        )

    @staticmethod
    def _required_tool_chain(
        definition: AgentDefinition,
        required_tools: set[str] | None = None,
    ) -> set[str]:
        tool_by_name = {tool.name: tool for tool in definition.tools}
        needed_tools = set(required_tools or definition.required_tools)
        pending = list(needed_tools)
        while pending:
            descriptor = tool_by_name.get(pending.pop())
            if descriptor is None:
                continue
            for prerequisite in descriptor.prerequisites:
                if prerequisite not in needed_tools:
                    needed_tools.add(prerequisite)
                    pending.append(prerequisite)
        return needed_tools

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
        forced_tool_name: str | None = None,
        run_context: str | None = None,
        session_id: str | None = None,
    ) -> AgentExecutionResult:
        priority = (
            ModelRequestPriority.FOREGROUND
            if definition.mode == AgentMode.CHAT
            else ModelRequestPriority.BACKGROUND
        )
        for attempt in range(MAX_PROVIDER_REQUEST_RETRIES + 1):
            event_emitted = False

            def publish_event(event: LlmAgentEvent) -> None:
                nonlocal event_emitted
                event_emitted = True
                on_event(event)

            try:
                async with model_request_slot_async(priority):
                    result = await self._run_once_attempt(
                        model,
                        profile,
                        definition,
                        messages,
                        registry,
                        publish_event,
                        max_tool_calls=max_tool_calls,
                        tool_timeout_seconds=tool_timeout_seconds,
                        reasoning_enabled=reasoning_enabled,
                        forced_tool_name=forced_tool_name,
                        run_context=run_context,
                        session_id=session_id,
                    )
                return result.model_copy(
                    update={"retry_count": result.retry_count + attempt}
                )
            except TransientProviderRequestError as error:
                if event_emitted or attempt >= MAX_PROVIDER_REQUEST_RETRIES:
                    raise
                defer_model_requests(provider_retry_delay_seconds(error, attempt))
        raise AssertionError("模型重试循环必须返回或抛出异常")

    async def _run_once_attempt(
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
        forced_tool_name: str | None = None,
        run_context: str | None = None,
        session_id: str | None = None,
    ) -> AgentExecutionResult:
        tool_result_cache: dict[str, str] = {}
        agno_tools = self._tools(
            registry,
            definition,
            tool_timeout_seconds,
            tool_result_cache,
        )
        agno_model = create_agent_model(
            model,
            profile,
            reasoning_enabled=reasoning_enabled,
            forced_tool_name=forced_tool_name,
        )
        agent = Agent(
            id=definition.agent_id,
            model=agno_model,
            instructions=(
                f"{definition.prompt}\n\n{TOOL_SEQUENCE_INSTRUCTION}"
                if agno_tools
                else definition.prompt
            ),
            additional_input=(
                [
                    Message(
                        role="system",
                        content=run_context,
                        add_to_agent_memory=False,
                    )
                ]
                if run_context
                else None
            ),
            tools=agno_tools,
            tool_choice=(
                agent_tool_choice(
                    profile,
                    reasoning_enabled=reasoning_enabled,
                    forced_tool_name=forced_tool_name,
                )
                if agno_tools
                else None
            ),
            tool_call_limit=max_tool_calls,
            db=(
                self.session_context.database
                if self.session_context is not None and session_id is not None
                else None
            ),
            session_id=session_id,
            add_history_to_context=(
                self.session_context is not None and session_id is not None
            ),
            num_history_runs=AGNO_HISTORY_RUN_COUNT,
            max_tool_calls_from_history=AGNO_HISTORY_TOOL_CALL_LIMIT,
            enable_session_summaries=(
                self.session_context is not None and session_id is not None
            ),
            add_session_summary_to_context=(
                self.session_context is not None and session_id is not None
            ),
            compress_tool_results=bool(agno_tools),
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
            return await self._consume(
                stream,
                on_event,
                required_tools=definition.required_tools,
            )
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
        result_cache: dict[str, str],
    ) -> list[Function]:
        functions: list[Function] = []
        for schema in registry.schemas(definition.allowed_tools):
            function_schema = schema["function"]
            name = str(function_schema["name"])

            async def execute_tool(
                _tool_name: str = name,
                **arguments: Any,
            ) -> str:
                signature = json.dumps(
                    {"name": _tool_name, "arguments": arguments},
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                cached_result = result_cache.get(signature)
                if cached_result is not None:
                    return cached_result
                result = await registry.execute(
                    AgentToolCall(
                        call_id=f"tool-{uuid7().hex}",
                        name=_tool_name,
                        arguments=arguments,
                    ),
                    definition.allowed_tools,
                    timeout_seconds,
                )
                serialized_result = json.dumps(result, ensure_ascii=False)
                result_cache[signature] = serialized_result
                return serialized_result

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
        stream: AsyncIterator[RunOutputEvent],
        on_event: AgnoEventHandler,
        *,
        required_tools: set[str],
    ) -> AgentExecutionResult:
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        successful_tools: set[str] = set()
        seen_tool_calls: set[str] = set()
        tool_call_count = 0
        pending_deltas: list[tuple[LlmAgentEventType, str]] = []
        pending_character_count = 0
        published_delta_types: set[LlmAgentEventType] = set()
        last_delta_flush = monotonic()
        publish_text = not required_tools

        def flush_deltas(*, force: bool = False) -> None:
            nonlocal pending_character_count, last_delta_flush
            elapsed = monotonic() - last_delta_flush
            if not force and (
                pending_character_count < STREAM_DELTA_CHARACTER_LIMIT
                and elapsed < STREAM_DELTA_INTERVAL_SECONDS
            ):
                return
            for event_type, content in pending_deltas:
                on_event(LlmAgentEvent(event_type=event_type, content=content))
            pending_deltas.clear()
            pending_character_count = 0
            last_delta_flush = monotonic()

        def queue_delta(event_type: LlmAgentEventType, content: str) -> None:
            nonlocal pending_character_count
            if event_type not in published_delta_types:
                published_delta_types.add(event_type)
                on_event(LlmAgentEvent(event_type=event_type, content=content))
                return
            if pending_deltas and pending_deltas[-1][0] == event_type:
                previous_type, previous_content = pending_deltas[-1]
                pending_deltas[-1] = (previous_type, previous_content + content)
            else:
                pending_deltas.append((event_type, content))
            pending_character_count += len(content)
            flush_deltas()

        async for event in stream:
            if isinstance(event, RunContentEvent):
                if isinstance(event.content, str) and event.content:
                    if publish_text:
                        content_parts.append(event.content)
                        queue_delta(LlmAgentEventType.TEXT_DELTA, event.content)
                if event.reasoning_content:
                    reasoning_parts.append(event.reasoning_content)
                    queue_delta(
                        LlmAgentEventType.REASONING_DELTA,
                        event.reasoning_content,
                    )
            elif isinstance(event, ReasoningStepEvent):
                if event.reasoning_content:
                    reasoning_parts.append(event.reasoning_content)
                    queue_delta(
                        LlmAgentEventType.REASONING_DELTA,
                        event.reasoning_content,
                    )
            elif isinstance(event, ToolCallStartedEvent) and event.tool is not None:
                flush_deltas(force=True)
                call_id = event.tool.tool_call_id
                if call_id is None or call_id not in seen_tool_calls:
                    tool_call_count += 1
                    if call_id is not None:
                        seen_tool_calls.add(call_id)
                on_event(
                    LlmAgentEvent(
                        event_type=LlmAgentEventType.TOOL_CALL_STARTED,
                        call_id=event.tool.tool_call_id,
                        name=event.tool.tool_name,
                        arguments=event.tool.tool_args or {},
                    )
                )
            elif isinstance(event, ToolCallCompletedEvent) and event.tool is not None:
                flush_deltas(force=True)
                result = _tool_result(event.tool.result)
                failed = event.tool.tool_call_error is True or result.get("ok") is False
                if not failed and event.tool.tool_name:
                    successful_tools.add(event.tool.tool_name)
                    if required_tools <= successful_tools:
                        publish_text = True
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
                flush_deltas(force=True)
                raise classify_provider_error(
                    ProviderRequestError(event.content or "Agno Agent 运行失败")
                )
            elif isinstance(event, RunCancelledEvent):
                flush_deltas(force=True)
                raise asyncio.CancelledError
            elif isinstance(event, RunCompletedEvent):
                if (
                    not content_parts
                    and not successful_tools
                    and isinstance(event.content, str)
                    and event.content
                ):
                    content_parts.append(event.content)
                    queue_delta(LlmAgentEventType.TEXT_DELTA, event.content)
                if not reasoning_parts and event.reasoning_content:
                    reasoning_parts.append(event.reasoning_content)
                    queue_delta(
                        LlmAgentEventType.REASONING_DELTA,
                        event.reasoning_content,
                    )
                flush_deltas(force=True)
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
            tool_call_count=tool_call_count,
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
