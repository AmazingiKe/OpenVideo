"""单一 Agent 循环集中实施工具、预算、取消与结果约束。"""

from __future__ import annotations

import asyncio
import inspect
import json
from collections.abc import Awaitable, Callable
from copy import deepcopy
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

from pydantic import BaseModel, ValidationError

from openvideo.core.agent_runtime_models import (
    AgentArtifact,
    AgentDefinition,
    AgentEvent,
    AgentEventType,
    AgentModelResponse,
    AgentRun,
    AgentRunStage,
    AgentSession,
    AgentToolCall,
)
from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.identifiers import uuid7


MAX_AGENT_STEPS = 8
MAX_AGENT_TOOL_CALLS = 12
AGENT_RUN_TIMEOUT_SECONDS = 180
AGENT_TOOL_TIMEOUT_SECONDS = 60
MAX_CONTEXT_CHARACTERS = 48_000


class AgentRuntimeError(RuntimeError):
    """运行无法满足 Agent 声明时保留稳定错误码和用户可读原因。"""

    def __init__(self, message: str, code: str = "agent_runtime_error") -> None:
        super().__init__(message)
        self.code = code


class AgentCapabilityError(AgentRuntimeError):
    """模型或供应商缺少声明能力时禁止把失败伪装成成功。"""

    def __init__(self, message: str) -> None:
        super().__init__(message, "capability_unavailable")


class AgentCancelledError(AgentRuntimeError):
    """用户取消与供应商故障分开记录，供恢复界面准确呈现。"""

    def __init__(self) -> None:
        super().__init__("用户已取消 Agent 运行", "cancelled")


class AgentEventRepository(Protocol):
    def save_agent_session(self, session: AgentSession) -> None: ...

    def load_agent_session(self, session_id: str) -> AgentSession | None: ...

    def save_agent_run(self, run: AgentRun) -> None: ...

    def load_agent_run(self, run_id: str) -> AgentRun | None: ...

    def load_agent_runs(self, session_id: str | None = None) -> list[AgentRun]: ...

    def append_agent_event(
        self,
        session_id: str,
        run_id: str | None,
        event_type: AgentEventType,
        payload: dict[str, Any],
    ) -> AgentEvent: ...

    def load_agent_events(
        self, session_id: str, *, after_sequence: int = 0
    ) -> list[AgentEvent]: ...

    def load_agent_artifacts(
        self, *, run_id: str | None = None, session_id: str | None = None
    ) -> list[AgentArtifact]: ...


class AgentSessionStore:
    """持久化事件既服务 SSE 恢复，也派生下一轮模型上下文。"""

    def __init__(self, repository: AgentEventRepository) -> None:
        self.repository = repository

    def append(
        self,
        session_id: str,
        run_id: str | None,
        event_type: AgentEventType,
        payload: dict[str, Any] | None = None,
    ) -> AgentEvent:
        event = self.repository.append_agent_event(
            session_id, run_id, event_type, payload or {}
        )
        if run_id and (run := self.repository.load_agent_run(run_id)) is not None:
            self.repository.save_agent_run(
                run.model_copy(
                    update={
                        "latest_event_sequence": event.sequence,
                        "updated_at": event.created_at,
                    }
                )
            )
        return event

    def events(self, session_id: str, *, after_sequence: int = 0) -> list[AgentEvent]:
        return self.repository.load_agent_events(
            session_id, after_sequence=after_sequence
        )

    def model_context(self, session_id: str) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        for event in self.events(session_id):
            payload = event.payload
            if event.event_type == AgentEventType.RUN_STATUS and payload.get("input"):
                messages.append({"role": "user", "content": str(payload["input"])})
            elif event.event_type == AgentEventType.MESSAGE_COMPLETED:
                message: dict[str, Any] = {
                    "role": "assistant",
                    "content": str(payload.get("content", "")),
                }
                if payload.get("tool_calls"):
                    message["tool_calls"] = payload["tool_calls"]
                messages.append(message)
            elif event.event_type == AgentEventType.TOOL_STATUS and payload.get(
                "stage"
            ) in {"completed", "failed"}:
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": str(payload["call_id"]),
                        "content": json.dumps(
                            payload.get("result"), ensure_ascii=False
                        ),
                    }
                )
        return messages


ToolHandler = Callable[[BaseModel], Any | Awaitable[Any]]
ToolPrerequisite = Callable[[], tuple[bool, str | None]]


@dataclass(frozen=True)
class AgentTool:
    name: str
    description: str
    parameters_model: type[BaseModel]
    handler: ToolHandler
    prerequisite: ToolPrerequisite | None = None


class AgentToolRegistry:
    """工具注册表在运行前校验声明，并集中生成供应商兼容 Schema。"""

    def __init__(self) -> None:
        self._tools: dict[str, AgentTool] = {}

    def register(self, tool: AgentTool) -> None:
        if tool.name in self._tools:
            raise ValueError(f"工具已注册：{tool.name}")
        self._tools[tool.name] = tool

    def validate(self, allowed_tools: tuple[str, ...]) -> None:
        missing = set(allowed_tools) - self._tools.keys()
        if missing:
            raise AgentRuntimeError(
                f"Agent 配置引用了不存在的工具：{', '.join(sorted(missing))}",
                "tool_not_registered",
            )

    def schemas(self, allowed_tools: tuple[str, ...]) -> list[dict[str, Any]]:
        self.validate(allowed_tools)
        return [
            {
                "type": "function",
                "function": {
                    "name": self._tools[name].name,
                    "description": self._tools[name].description,
                    "parameters": provider_json_schema(
                        self._tools[name].parameters_model.model_json_schema()
                    ),
                },
            }
            for name in allowed_tools
        ]

    async def execute(
        self,
        call: AgentToolCall,
        allowed_tools: tuple[str, ...],
        timeout_seconds: float,
    ) -> dict[str, Any]:
        if call.name not in allowed_tools:
            return _tool_error(
                "tool_not_allowed", f"当前 Agent 不允许使用工具：{call.name}"
            )
        tool = self._tools.get(call.name)
        if tool is None:
            return _tool_error("tool_not_registered", f"工具不存在：{call.name}")
        if tool.prerequisite is not None:
            available, reason = tool.prerequisite()
            if not available:
                return _tool_error(
                    "prerequisite_not_met", reason or "工具前置条件未满足"
                )
        try:
            parameters = tool.parameters_model.model_validate(call.arguments)
        except ValidationError as error:
            return {
                **_tool_error("invalid_arguments", "工具参数无效"),
                "details": error.errors(include_url=False),
                "retryable": True,
            }

        async def invoke() -> Any:
            if inspect.iscoroutinefunction(tool.handler):
                return await tool.handler(parameters)
            result = await asyncio.to_thread(tool.handler, parameters)
            return await result if inspect.isawaitable(result) else result

        try:
            result = await asyncio.wait_for(invoke(), timeout=timeout_seconds)
            if isinstance(result, dict):
                return result
            return {"ok": True, "result": result}
        except TimeoutError:
            return _tool_error("tool_timeout", f"工具执行超过 {timeout_seconds:g} 秒")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            return _tool_error("tool_execution_failed", str(error) or "工具执行失败")


class AgentModelAdapter(Protocol):
    async def complete(
        self,
        model: AiModelConfiguration,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        on_chunk: Callable[[str], None],
    ) -> AgentModelResponse: ...


class AgentRuntime:
    def __init__(
        self,
        store: AgentSessionStore,
        registry: AgentToolRegistry,
        model_adapter: AgentModelAdapter,
    ) -> None:
        self.store = store
        self.registry = registry
        self.model_adapter = model_adapter
        self._cancel_events: dict[str, asyncio.Event] = {}
        self._active_tasks: dict[str, asyncio.Task[Any]] = {}

    def cancel(self, run_id: str) -> None:
        self._cancel_events.setdefault(run_id, asyncio.Event()).set()
        if task := self._active_tasks.get(run_id):
            task.cancel()

    async def run(
        self,
        run: AgentRun,
        model: AiModelConfiguration,
        definition: AgentDefinition,
        user_content: str,
        *,
        max_steps: int = MAX_AGENT_STEPS,
        max_tool_calls: int = MAX_AGENT_TOOL_CALLS,
        run_timeout_seconds: float = AGENT_RUN_TIMEOUT_SECONDS,
        tool_timeout_seconds: float = AGENT_TOOL_TIMEOUT_SECONDS,
        max_context_characters: int = MAX_CONTEXT_CHARACTERS,
    ) -> AgentRun:
        self.registry.validate(definition.allowed_tools)
        cancel_event = self._cancel_events.setdefault(run.run_id, asyncio.Event())
        current_task = asyncio.current_task()
        if current_task is not None:
            self._active_tasks[run.run_id] = current_task
        started_at = datetime.now(UTC)
        running = run.model_copy(
            update={
                "stage": AgentRunStage.RUNNING,
                "started_at": started_at,
                "updated_at": started_at,
            }
        )
        self.store.repository.save_agent_run(running)
        self.store.append(
            run.session_id,
            run.run_id,
            AgentEventType.RUN_STATUS,
            {"stage": "running", "input": user_content},
        )
        try:
            return await asyncio.wait_for(
                self._run_loop(
                    running,
                    model,
                    definition,
                    cancel_event,
                    max_steps,
                    max_tool_calls,
                    tool_timeout_seconds,
                    max_context_characters,
                ),
                timeout=run_timeout_seconds,
            )
        except (AgentCancelledError, asyncio.CancelledError):
            return self._finish(
                running, AgentRunStage.CANCELLED, "cancelled", "用户已取消 Agent 运行"
            )
        except TimeoutError:
            return self._finish(
                running,
                AgentRunStage.FAILED,
                "run_timeout",
                f"Agent 运行超过 {run_timeout_seconds:g} 秒",
            )
        except AgentRuntimeError as error:
            return self._finish(running, AgentRunStage.FAILED, error.code, str(error))
        except Exception as error:
            return self._finish(
                running,
                AgentRunStage.FAILED,
                "agent_runtime_error",
                str(error) or "Agent 运行失败",
            )
        finally:
            self._cancel_events.pop(run.run_id, None)
            self._active_tasks.pop(run.run_id, None)

    async def _run_loop(
        self,
        run: AgentRun,
        model: AiModelConfiguration,
        definition: AgentDefinition,
        cancel_event: asyncio.Event,
        max_steps: int,
        max_tool_calls: int,
        tool_timeout_seconds: float,
        max_context_characters: int,
    ) -> AgentRun:
        tool_call_count = 0
        successful_tools: set[str] = set()
        tools = self.registry.schemas(definition.allowed_tools)
        for step_number in range(1, max_steps + 1):
            self._raise_if_cancelled(cancel_event)
            messages = [
                {"role": "system", "content": definition.prompt},
                *self.store.model_context(run.session_id),
            ]
            messages = self._compress_context(run, messages, max_context_characters)
            response = await self.model_adapter.complete(
                model,
                messages,
                tools,
                lambda chunk: self.store.append(
                    run.session_id,
                    run.run_id,
                    AgentEventType.MESSAGE_DELTA,
                    {"content": chunk, "step": step_number},
                ),
            )
            self._raise_if_cancelled(cancel_event)
            serialized_calls = [
                {
                    "id": call.call_id,
                    "type": "function",
                    "function": {
                        "name": call.name,
                        "arguments": json.dumps(call.arguments, ensure_ascii=False),
                    },
                }
                for call in response.tool_calls
            ]
            self.store.append(
                run.session_id,
                run.run_id,
                AgentEventType.MESSAGE_COMPLETED,
                {"content": response.content, "tool_calls": serialized_calls},
            )
            if not response.tool_calls:
                missing = definition.required_tools - successful_tools
                if missing:
                    raise AgentRuntimeError(
                        f"运行结束前未成功调用必需工具：{', '.join(sorted(missing))}",
                        "required_result_missing",
                    )
                artifacts = self.store.repository.load_agent_artifacts(
                    run_id=run.run_id
                )
                if definition.requires_approval and not artifacts:
                    raise AgentRuntimeError(
                        "运行未生成必需的审批结果", "required_result_missing"
                    )
                stage = (
                    AgentRunStage.WAITING_FOR_APPROVAL
                    if artifacts
                    else AgentRunStage.COMPLETE
                )
                return self._finish(run, stage)
            tool_call_count += len(response.tool_calls)
            if tool_call_count > max_tool_calls:
                raise AgentRuntimeError(
                    f"单轮工具调用超过上限 {max_tool_calls} 次", "tool_call_limit"
                )
            for call in response.tool_calls:
                self._raise_if_cancelled(cancel_event)
                self.store.append(
                    run.session_id,
                    run.run_id,
                    AgentEventType.TOOL_STATUS,
                    {**call.model_dump(mode="json"), "stage": "started"},
                )
                result = await self.registry.execute(
                    call, definition.allowed_tools, tool_timeout_seconds
                )
                if result.get("ok") is True:
                    successful_tools.add(call.name)
                self.store.append(
                    run.session_id,
                    run.run_id,
                    AgentEventType.TOOL_STATUS,
                    {
                        "call_id": call.call_id,
                        "name": call.name,
                        "stage": "completed" if result.get("ok") is True else "failed",
                        "result": result,
                    },
                )
        raise AgentRuntimeError(f"Agent 单轮超过最大 Step 数 {max_steps}", "step_limit")

    def _compress_context(
        self,
        run: AgentRun,
        messages: list[dict[str, Any]],
        limit: int,
    ) -> list[dict[str, Any]]:
        lengths = [len(json.dumps(message, ensure_ascii=False)) for message in messages]
        if sum(lengths) <= limit:
            return messages
        kept = [messages[0]]
        remaining = limit - lengths[0]
        for message, length in reversed(
            list(zip(messages[1:], lengths[1:], strict=True))
        ):
            if length > remaining:
                break
            kept.insert(1, message)
            remaining -= length
        self.store.append(
            run.session_id,
            run.run_id,
            AgentEventType.CONTEXT_COMPRESSED,
            {"removed_message_count": len(messages) - len(kept)},
        )
        return kept

    @staticmethod
    def _raise_if_cancelled(cancel_event: asyncio.Event) -> None:
        if cancel_event.is_set():
            raise AgentCancelledError()

    def _finish(
        self,
        run: AgentRun,
        stage: AgentRunStage,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> AgentRun:
        completed_at = datetime.now(UTC)
        event_type = {
            AgentRunStage.COMPLETE: AgentEventType.RUN_COMPLETED,
            AgentRunStage.WAITING_FOR_APPROVAL: AgentEventType.RUN_COMPLETED,
            AgentRunStage.FAILED: AgentEventType.RUN_FAILED,
            AgentRunStage.CANCELLED: AgentEventType.RUN_CANCELLED,
        }[stage]
        event = self.store.append(
            run.session_id,
            run.run_id,
            event_type,
            {
                "stage": stage.value,
                "error_code": error_code,
                "error_message": error_message,
            },
        )
        finished = run.model_copy(
            update={
                "stage": stage,
                "error_code": error_code,
                "error_message": error_message,
                "latest_event_sequence": event.sequence,
                "updated_at": completed_at,
                "completed_at": completed_at,
            }
        )
        self.store.repository.save_agent_run(finished)
        return finished


def new_agent_run(session_id: str, request_key: str, model_id: str) -> AgentRun:
    return AgentRun(
        run_id=f"run-{uuid7().hex}",
        session_id=session_id,
        request_key=request_key,
        model_id=model_id,
    )


def provider_json_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """把 Pydantic Schema 收敛到主流工具协议共同支持的子集。"""

    definitions = schema.get("$defs", {})

    def resolve(value: Any) -> Any:
        if isinstance(value, list):
            return [resolve(item) for item in value]
        if not isinstance(value, dict):
            return value
        if "$ref" in value:
            reference_name = str(value["$ref"]).rsplit("/", 1)[-1]
            resolved = deepcopy(definitions.get(reference_name, {}))
            resolved.update({key: item for key, item in value.items() if key != "$ref"})
            return resolve(resolved)
        resolved = {
            key: resolve(item)
            for key, item in value.items()
            if key not in {"$defs", "default", "title", "examples"}
        }
        variants = resolved.pop("anyOf", None)
        if isinstance(variants, list):
            non_null = [item for item in variants if item.get("type") != "null"]
            nullable = len(non_null) != len(variants)
            if len(non_null) == 1:
                resolved.update(non_null[0])
                if nullable:
                    resolved["nullable"] = True
            else:
                resolved["oneOf"] = non_null
                if nullable:
                    resolved["nullable"] = True
        if resolved.get("type") == "object":
            resolved.setdefault("properties", {})
            resolved["additionalProperties"] = False
        return resolved

    normalized = resolve(schema)
    return normalized


def _tool_error(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "error_code": code, "error": message}
