"""轻量 Agent 循环集中约束事件顺序、工具边界、取消与循环上限。"""

from __future__ import annotations

import inspect
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

from pydantic import BaseModel, ValidationError

from openvideo.core.agent_runtime_models import (
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


MAX_AGENT_STEPS = 6
MAX_AGENT_TOOL_CALLS = 8


class AgentRuntimeError(RuntimeError):
    """运行无法安全继续时保留明确的用户可解释原因。"""


class AgentCancelledError(AgentRuntimeError):
    """用户取消与模型或工具失败分开记录，避免 UI 将其显示为故障。"""


class AgentEventRepository(Protocol):
    def save_agent_session(self, session: AgentSession) -> None: ...

    def load_agent_session(self, session_id: str) -> AgentSession | None: ...

    def save_agent_run(self, run: AgentRun) -> None: ...

    def load_agent_run(self, run_id: str) -> AgentRun | None: ...

    def load_agent_runs(self) -> list[AgentRun]: ...

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


class AgentSessionStore:
    """将追加事件派生为模型消息，归档事件永不污染新 Agent 上下文。"""

    def __init__(self, repository: AgentEventRepository) -> None:
        self.repository = repository

    def append(
        self,
        session_id: str,
        run_id: str | None,
        event_type: AgentEventType,
        payload: dict[str, Any] | None = None,
    ) -> AgentEvent:
        return self.repository.append_agent_event(
            session_id, run_id, event_type, payload or {}
        )

    def events(self, session_id: str, *, after_sequence: int = 0) -> list[AgentEvent]:
        return self.repository.load_agent_events(
            session_id, after_sequence=after_sequence
        )

    def model_context(self, session_id: str) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        for event in self.events(session_id):
            payload = event.payload
            if event.event_type == AgentEventType.USER_MESSAGE:
                messages.append({"role": "user", "content": str(payload["content"])})
            elif event.event_type == AgentEventType.ASSISTANT_MESSAGE:
                message: dict[str, Any] = {
                    "role": "assistant",
                    "content": str(payload.get("content", "")),
                }
                if payload.get("tool_calls"):
                    message["tool_calls"] = payload["tool_calls"]
                messages.append(message)
            elif event.event_type == AgentEventType.TOOL_RESULT:
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


@dataclass(frozen=True)
class AgentTool:
    name: str
    description: str
    parameters_model: type[BaseModel]
    handler: ToolHandler


class AgentToolRegistry:
    """工具参数先由 Pydantic 校验，模型永远不能绕过领域边界调用处理器。"""

    def __init__(self) -> None:
        self._tools: dict[str, AgentTool] = {}

    def register(self, tool: AgentTool) -> None:
        if tool.name in self._tools:
            raise ValueError(f"工具已注册：{tool.name}")
        self._tools[tool.name] = tool

    def schemas(self, allowed_tools: tuple[str, ...]) -> list[dict[str, Any]]:
        return [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters_model.model_json_schema(),
                },
            }
            for name in allowed_tools
            if (tool := self._tools.get(name)) is not None
        ]

    async def execute(self, call: AgentToolCall, allowed_tools: tuple[str, ...]) -> Any:
        if call.name not in allowed_tools:
            return {"ok": False, "error": f"当前 Agent 不允许使用工具 {call.name}"}
        tool = self._tools.get(call.name)
        if tool is None:
            return {"ok": False, "error": f"工具不存在：{call.name}"}
        try:
            parameters = tool.parameters_model.model_validate(call.arguments)
        except ValidationError as error:
            return {
                "ok": False,
                "error": "工具参数无效",
                "details": error.errors(include_url=False),
            }
        try:
            result = tool.handler(parameters)
            if inspect.isawaitable(result):
                result = await result
            return result
        except Exception as error:
            return {"ok": False, "error": str(error) or "工具执行失败"}


@dataclass(frozen=True)
class AgentPreset:
    persona: str
    dynamic_context: Callable[[], str]
    allowed_tools: tuple[str, ...]


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
        self._cancelled_runs: set[str] = set()

    def cancel(self, run_id: str) -> None:
        self._cancelled_runs.add(run_id)

    async def run(
        self,
        run: AgentRun,
        model: AiModelConfiguration,
        preset: AgentPreset,
        user_content: str,
        *,
        max_steps: int = MAX_AGENT_STEPS,
        max_tool_calls: int = MAX_AGENT_TOOL_CALLS,
    ) -> AgentRun:
        running = run.model_copy(
            update={
                "stage": AgentRunStage.RUNNING,
                "updated_at": datetime.now(UTC),
            }
        )
        self.store.repository.save_agent_run(running)
        self.store.append(run.session_id, run.run_id, AgentEventType.TURN_START)
        self.store.append(
            run.session_id,
            run.run_id,
            AgentEventType.USER_MESSAGE,
            {"content": user_content},
        )
        self._status(running, "running")
        tool_call_count = 0
        try:
            for step_number in range(1, max_steps + 1):
                self._raise_if_cancelled(run.run_id)
                self.store.append(
                    run.session_id,
                    run.run_id,
                    AgentEventType.STEP_START,
                    {"step": step_number},
                )
                context = preset.dynamic_context().strip()
                system_content = preset.persona
                if context:
                    system_content = f"{system_content}\n\n当前上下文：\n{context}"
                messages = [
                    {"role": "system", "content": system_content},
                    *self.store.model_context(run.session_id),
                ]
                tools = self.registry.schemas(preset.allowed_tools)
                response = await self.model_adapter.complete(
                    model,
                    messages,
                    tools,
                    lambda chunk: self.store.append(
                        run.session_id,
                        run.run_id,
                        AgentEventType.ASSISTANT_CHUNK,
                        {"content": chunk, "step": step_number},
                    ),
                )
                self._raise_if_cancelled(run.run_id)
                if response.degraded_reason:
                    self._status(running, "degraded", response.degraded_reason)
                serialized_calls = [
                    {
                        "id": call.call_id,
                        "type": "function",
                        "function": {
                            "name": call.name,
                            "arguments": json.dumps(
                                call.arguments, ensure_ascii=False
                            ),
                        },
                    }
                    for call in response.tool_calls
                ]
                self.store.append(
                    run.session_id,
                    run.run_id,
                    AgentEventType.ASSISTANT_MESSAGE,
                    {"content": response.content, "tool_calls": serialized_calls},
                )
                if not response.tool_calls:
                    self.store.append(
                        run.session_id,
                        run.run_id,
                        AgentEventType.STEP_END,
                        {"step": step_number, "reason": "assistant_message"},
                    )
                    return self._finish(running, AgentRunStage.COMPLETE)
                tool_call_count += len(response.tool_calls)
                if tool_call_count > max_tool_calls:
                    raise AgentRuntimeError(
                        f"单轮工具调用超过上限 {max_tool_calls} 次"
                    )
                for call in response.tool_calls:
                    self._raise_if_cancelled(run.run_id)
                    self.store.append(
                        run.session_id,
                        run.run_id,
                        AgentEventType.TOOL_CALL,
                        call.model_dump(mode="json"),
                    )
                    result = await self.registry.execute(call, preset.allowed_tools)
                    self.store.append(
                        run.session_id,
                        run.run_id,
                        AgentEventType.TOOL_RESULT,
                        {"call_id": call.call_id, "name": call.name, "result": result},
                    )
                self.store.append(
                    run.session_id,
                    run.run_id,
                    AgentEventType.STEP_END,
                    {"step": step_number, "reason": "tool_calls"},
                )
            raise AgentRuntimeError(f"Agent 单轮超过最大 Step 数 {max_steps}")
        except AgentCancelledError as error:
            return self._finish(running, AgentRunStage.CANCELLED, str(error))
        except Exception as error:
            return self._finish(
                running, AgentRunStage.FAILED, str(error) or "Agent 运行失败"
            )
        finally:
            self._cancelled_runs.discard(run.run_id)

    def _raise_if_cancelled(self, run_id: str) -> None:
        if run_id in self._cancelled_runs:
            raise AgentCancelledError("用户已取消 Agent 运行")

    def _status(self, run: AgentRun, status: str, message: str | None = None) -> None:
        payload: dict[str, Any] = {"stage": status}
        if message:
            payload["message"] = message
        self.store.append(
            run.session_id, run.run_id, AgentEventType.RUN_STATUS, payload
        )

    def _finish(
        self,
        run: AgentRun,
        stage: AgentRunStage,
        error_message: str | None = None,
    ) -> AgentRun:
        self.store.append(
            run.session_id,
            run.run_id,
            AgentEventType.TURN_END,
            {"stage": stage.value, "error_message": error_message},
        )
        finished = run.model_copy(
            update={
                "stage": stage,
                "error_message": error_message,
                "updated_at": datetime.now(UTC),
            }
        )
        self.store.repository.save_agent_run(finished)
        self._status(finished, stage.value, error_message)
        return finished


def new_agent_run(session_id: str) -> AgentRun:
    return AgentRun(run_id=f"run-{uuid7().hex}", session_id=session_id)
