from __future__ import annotations

import pytest
from agno.agent import Agent
from agno.models.response import ToolExecution
from agno.run.agent import (
    RunCompletedEvent,
    RunContentEvent,
    ToolCallCompletedEvent,
    ToolCallStartedEvent,
)
from pydantic import BaseModel

from openvideo.agent_runtime import AgentTool, AgentToolRegistry
from openvideo.core.agent_runtime_models import (
    AgentDefinition,
    AgentMode,
    AgentToolDescriptor,
)
from openvideo.core.ai_models import AiModelConfiguration
from openvideo.llm.agno_executor import AgnoAgentExecutor
from openvideo.llm.agno_session_context import AgnoSessionContext
from openvideo.llm.events import LlmAgentEventType
from openvideo.llm.errors import TransientProviderRequestError
from openvideo.llm.model_profile import ModelCapabilities, ModelProfile, Support


class EchoInput(BaseModel):
    text: str


def chat_definition() -> AgentDefinition:
    return AgentDefinition(
        agent_id="test",
        title="测试",
        description="验证供应商重试边界",
        mode=AgentMode.CHAT,
        prompt="回答测试请求",
    )


def online_model() -> AiModelConfiguration:
    return AiModelConfiguration(
        name="实验模型",
        litellm_model="deepseek/deepseek-v4-flash-vision-exp",
        api_key="secret",
    )


def text_profile() -> ModelProfile:
    return ModelProfile(
        provider="deepseek",
        model="deepseek-v4-flash-vision-exp",
        capabilities=ModelCapabilities(),
    )


@pytest.mark.asyncio
async def test_transient_failure_retries_before_any_event(monkeypatch):
    attempts = 0
    delays: list[float] = []

    def arun(self, input, **_options):
        nonlocal attempts
        attempts += 1

        async def events():
            if attempts == 1:
                raise RuntimeError("429 rate limit")
            yield RunContentEvent(content="完成")
            yield RunCompletedEvent(content="完成")

        return events()

    monkeypatch.setattr(Agent, "arun", arun)
    monkeypatch.setattr(
        "openvideo.llm.agno_executor.defer_model_requests",
        delays.append,
    )

    result = await AgnoAgentExecutor().run(
        online_model(),
        text_profile(),
        chat_definition(),
        [{"role": "user", "content": "执行"}],
        AgentToolRegistry(),
        lambda _event: None,
        max_tool_calls=4,
        tool_timeout_seconds=5,
    )

    assert result.content == "完成"
    assert result.retry_count == 1
    assert attempts == 2
    assert delays == [1.0]


@pytest.mark.asyncio
async def test_executor_delegates_session_history_and_compression_to_agno(
    monkeypatch,
    tmp_path,
):
    captured_agent = None
    captured_input = None

    def arun(self, input, **_options):
        nonlocal captured_agent, captured_input
        captured_agent = self
        captured_input = input

        async def events():
            yield RunContentEvent(content="连续回答")
            yield RunCompletedEvent(content="连续回答")

        return events()

    monkeypatch.setattr(Agent, "arun", arun)
    registry = AgentToolRegistry()
    registry.register(
        AgentTool(
            name="echo",
            description="回显",
            parameters_model=EchoInput,
            handler=lambda parameters: {"ok": True, "text": parameters.text},
        )
    )
    definition = chat_definition().model_copy(
        update={
            "tools": [
                AgentToolDescriptor(
                    name="echo",
                    description="回显",
                )
            ]
        }
    )
    session_context = AgnoSessionContext(tmp_path / "agent-context.sqlite3")

    await AgnoAgentExecutor(session_context).run(
        online_model(),
        text_profile(),
        definition,
        [{"role": "user", "content": "继续"}],
        registry,
        lambda _event: None,
        max_tool_calls=4,
        tool_timeout_seconds=5,
        historical_messages=[
            {"role": "user", "content": "上一问"},
            {"role": "assistant", "content": "上一答"},
        ],
        run_context="<当前聚焦状态>只属于本轮</当前聚焦状态>",
        session_id="session-test",
    )
    imported_session = await session_context.database.get_session("session-test")
    await session_context.close()

    assert captured_agent is not None
    assert captured_agent.db is session_context.database
    assert captured_agent.session_id == "session-test"
    assert captured_agent.add_history_to_context is True
    assert captured_agent.num_history_runs == 3
    assert captured_agent.enable_session_summaries is True
    assert captured_agent.add_session_summary_to_context is True
    assert captured_agent.compress_tool_results is True
    assert captured_agent.max_tool_calls_from_history == 3
    assert captured_input[0].content == "继续"
    assert captured_agent.additional_input[0].add_to_agent_memory is False
    assert "只属于本轮" in captured_agent.additional_input[0].content
    assert imported_session is not None
    assert [message.content for message in imported_session.get_messages()] == [
        "上一问",
        "上一答",
    ]


@pytest.mark.asyncio
async def test_transient_failure_does_not_retry_after_published_event(monkeypatch):
    attempts = 0
    captured_events = []

    def arun(self, input, **_options):
        nonlocal attempts
        attempts += 1

        async def events():
            yield RunContentEvent(content="已输出" * 100)
            raise RuntimeError("429 rate limit")

        return events()

    monkeypatch.setattr(Agent, "arun", arun)

    with pytest.raises(TransientProviderRequestError, match="429 rate limit"):
        await AgnoAgentExecutor().run(
            online_model(),
            text_profile(),
            chat_definition(),
            [{"role": "user", "content": "执行"}],
            AgentToolRegistry(),
            captured_events.append,
            max_tool_calls=4,
            tool_timeout_seconds=5,
        )

    assert attempts == 1
    assert captured_events[0].event_type == LlmAgentEventType.TEXT_DELTA


@pytest.mark.asyncio
async def test_agent_runtime_tool_calling(monkeypatch):
    tool = ToolExecution(
        tool_call_id="call-1",
        tool_name="echo",
        tool_args={"text": "证据"},
        result='{"ok":true,"text":"证据"}',
    )

    def arun(self, input, **_options):
        async def events():
            yield ToolCallStartedEvent(tool=tool)
            yield ToolCallCompletedEvent(tool=tool)
            yield RunContentEvent(content="完成")
            yield RunCompletedEvent(content="完成")

        return events()

    monkeypatch.setattr(Agent, "arun", arun)
    registry = AgentToolRegistry()
    registry.register(
        AgentTool(
            name="echo",
            description="回显证据",
            parameters_model=EchoInput,
            handler=lambda parameters: {"ok": True, "text": parameters.text},
        )
    )
    definition = AgentDefinition(
        agent_id="test",
        title="测试",
        description="验证 Agno 统一工具事件",
        mode=AgentMode.CHAT,
        prompt="调用工具",
        tools=[AgentToolDescriptor(name="echo", description="回显证据")],
    )
    model = AiModelConfiguration(
        name="实验模型",
        litellm_model="deepseek/deepseek-v4-flash-vision-exp",
        api_key="secret",
    )
    profile = ModelProfile(
        provider="deepseek",
        model="deepseek-v4-flash-vision-exp",
        capabilities=ModelCapabilities(tools=Support.YES),
    )
    captured_events = []

    result = await AgnoAgentExecutor().run(
        model,
        profile,
        definition,
        [{"role": "user", "content": "执行"}],
        registry,
        captured_events.append,
        max_tool_calls=4,
        tool_timeout_seconds=5,
    )

    assert result.content == "完成"
    assert result.successful_tools == {"echo"}
    assert [event.event_type for event in captured_events] == [
        LlmAgentEventType.TOOL_CALL_STARTED,
        LlmAgentEventType.TOOL_CALL_COMPLETED,
        LlmAgentEventType.TEXT_DELTA,
        LlmAgentEventType.RESPONSE_COMPLETED,
    ]


@pytest.mark.asyncio
async def test_identical_tool_arguments_reuse_the_first_result():
    execution_count = 0

    def execute(parameters: EchoInput):
        nonlocal execution_count
        execution_count += 1
        return {"ok": True, "text": parameters.text}

    registry = AgentToolRegistry()
    registry.register(
        AgentTool(
            name="echo",
            description="回显证据",
            parameters_model=EchoInput,
            handler=execute,
        )
    )
    definition = AgentDefinition(
        agent_id="test",
        title="测试",
        description="验证重复工具调用不会重复执行",
        mode=AgentMode.CHAT,
        prompt="调用工具",
        tools=[AgentToolDescriptor(name="echo", description="回显证据")],
    )
    functions = AgnoAgentExecutor._tools(registry, definition, 5, {})

    first_result = await functions[0].entrypoint(text="相同证据")
    second_result = await functions[0].entrypoint(text="相同证据")

    assert first_result == second_result
    assert execution_count == 1


@pytest.mark.asyncio
async def test_missing_required_tool_gets_one_forced_recovery(monkeypatch):
    tool = ToolExecution(
        tool_call_id="call-required",
        tool_name="echo",
        tool_args={"text": "证据"},
        result='{"ok":true,"text":"证据"}',
    )
    tool_choices = []
    tool_limits = []

    def arun(self, input, **_options):
        tool_choices.append(self.tool_choice)
        tool_limits.append(self.tool_call_limit)

        async def events():
            if len(tool_choices) == 1:
                yield RunContentEvent(content="尚未提交")
                yield RunCompletedEvent(content="尚未提交")
                return
            yield ToolCallStartedEvent(tool=tool)
            yield ToolCallCompletedEvent(tool=tool)
            yield RunContentEvent(content="已提交")
            yield RunCompletedEvent(content="已提交")

        return events()

    monkeypatch.setattr(Agent, "arun", arun)
    registry = AgentToolRegistry()
    registry.register(
        AgentTool(
            name="echo",
            description="回显证据",
            parameters_model=EchoInput,
            handler=lambda parameters: {"ok": True, "text": parameters.text},
        )
    )
    definition = AgentDefinition(
        agent_id="test",
        title="测试",
        description="验证必需工具收尾",
        mode=AgentMode.CHAT,
        prompt="必须调用工具",
        tools=[AgentToolDescriptor(name="echo", description="回显证据")],
        required_tools={"echo"},
    )
    model = AiModelConfiguration(
        name="实验模型",
        litellm_model="deepseek/deepseek-v4-flash-vision-exp",
        api_key="secret",
    )
    profile = ModelProfile(
        provider="deepseek",
        model="deepseek-v4-flash-vision-exp",
        capabilities=ModelCapabilities(
            tools=Support.YES,
            tool_choice_named=Support.YES,
        ),
    )

    result = await AgnoAgentExecutor().run(
        model,
        profile,
        definition,
        [{"role": "user", "content": "执行"}],
        registry,
        lambda _event: None,
        max_tool_calls=4,
        tool_timeout_seconds=5,
    )

    assert result.content == "已提交"
    assert result.successful_tools == {"echo"}
    assert result.tool_call_count == 1
    assert tool_choices == [
        "auto",
        {"type": "function", "function": {"name": "echo"}},
    ]
    assert tool_limits == [3, 4]


@pytest.mark.asyncio
async def test_stream_deltas_are_coalesced_before_persistence(monkeypatch):
    def arun(self, input, **_options):
        async def events():
            for _ in range(20):
                yield RunContentEvent(content="字")
            yield RunCompletedEvent(content="字" * 20)

        return events()

    monkeypatch.setattr(Agent, "arun", arun)
    definition = AgentDefinition(
        agent_id="test",
        title="测试",
        description="验证流式增量合并",
        mode=AgentMode.CHAT,
        prompt="直接回答",
    )
    model = AiModelConfiguration(
        name="实验模型",
        litellm_model="deepseek/deepseek-v4-flash-vision-exp",
        api_key="secret",
    )
    profile = ModelProfile(
        provider="deepseek",
        model="deepseek-v4-flash-vision-exp",
    )
    captured_events = []

    result = await AgnoAgentExecutor().run(
        model,
        profile,
        definition,
        [{"role": "user", "content": "执行"}],
        AgentToolRegistry(),
        captured_events.append,
        max_tool_calls=4,
        tool_timeout_seconds=5,
    )

    text_events = [
        event
        for event in captured_events
        if event.event_type == LlmAgentEventType.TEXT_DELTA
    ]
    assert result.content == "字" * 20
    assert "".join(event.content for event in text_events) == result.content
    assert len(text_events) <= 2


@pytest.mark.asyncio
async def test_long_stream_limits_persisted_delta_frequency(monkeypatch):
    character_count = 1_024

    def arun(self, input, **_options):
        async def events():
            for _ in range(character_count):
                yield RunContentEvent(content="字")
            yield RunCompletedEvent(content="字" * character_count)

        return events()

    monkeypatch.setattr(Agent, "arun", arun)
    definition = AgentDefinition(
        agent_id="test",
        title="测试",
        description="验证长输出不会放大持久化写入",
        mode=AgentMode.CHAT,
        prompt="直接回答",
    )
    model = AiModelConfiguration(
        name="实验模型",
        litellm_model="deepseek/deepseek-v4-flash-vision-exp",
        api_key="secret",
    )
    profile = ModelProfile(
        provider="deepseek",
        model="deepseek-v4-flash-vision-exp",
    )
    captured_events = []

    result = await AgnoAgentExecutor().run(
        model,
        profile,
        definition,
        [{"role": "user", "content": "执行"}],
        AgentToolRegistry(),
        captured_events.append,
        max_tool_calls=4,
        tool_timeout_seconds=5,
    )

    text_events = [
        event.content
        for event in captured_events
        if event.event_type == LlmAgentEventType.TEXT_DELTA
    ]
    assert result.content == "字" * character_count
    assert "".join(text_events) == result.content
    assert len(text_events) <= 5


@pytest.mark.asyncio
async def test_required_tool_preface_is_not_published_as_final_answer(monkeypatch):
    tool = ToolExecution(
        tool_call_id="call-evidence",
        tool_name="echo",
        tool_args={"text": "课程证据"},
        result='{"ok":true,"text":"课程证据"}',
    )

    def arun(self, input, **_options):
        async def events():
            yield RunContentEvent(content="让我先检索课程内容。")
            yield ToolCallStartedEvent(tool=tool)
            yield ToolCallCompletedEvent(tool=tool)
            yield RunContentEvent(content="这门课程讲解线性代数。")
            yield RunCompletedEvent(
                content="让我先检索课程内容。这门课程讲解线性代数。"
            )

        return events()

    monkeypatch.setattr(Agent, "arun", arun)
    registry = AgentToolRegistry()
    registry.register(
        AgentTool(
            name="echo",
            description="读取课程证据",
            parameters_model=EchoInput,
            handler=lambda parameters: {"ok": True, "text": parameters.text},
        )
    )
    definition = AgentDefinition(
        agent_id="test",
        title="测试",
        description="验证工具前置旁白不会进入最终回答",
        mode=AgentMode.CHAT,
        prompt="读取证据后直接回答",
        tools=[AgentToolDescriptor(name="echo", description="读取课程证据")],
        required_tools={"echo"},
    )
    model = AiModelConfiguration(
        name="实验模型",
        litellm_model="deepseek/deepseek-v4-flash-vision-exp",
        api_key="secret",
    )
    profile = ModelProfile(
        provider="deepseek",
        model="deepseek-v4-flash-vision-exp",
        capabilities=ModelCapabilities(tools=Support.YES),
    )
    captured_events = []

    result = await AgnoAgentExecutor().run(
        model,
        profile,
        definition,
        [{"role": "user", "content": "这门课程讲什么？"}],
        registry,
        captured_events.append,
        max_tool_calls=4,
        tool_timeout_seconds=5,
    )

    text_events = [
        event.content
        for event in captured_events
        if event.event_type == LlmAgentEventType.TEXT_DELTA
    ]
    assert result.content == "这门课程讲解线性代数。"
    assert text_events == ["这门课程讲解线性代数。"]


def test_unknown_named_tool_choice_uses_auto_for_required_tool_recovery():
    definition = AgentDefinition(
        agent_id="test",
        title="测试",
        description="验证未知能力不会强制指定工具",
        mode=AgentMode.CHAT,
        prompt="必须调用工具",
        tools=[AgentToolDescriptor(name="echo", description="回显证据")],
        required_tools={"echo"},
    )
    profile = ModelProfile(provider="deepseek", model="experimental")

    recovery_definition, forced_tool_name = AgnoAgentExecutor._recovery_definition(
        definition,
        {"echo"},
        set(),
        profile,
    )

    assert recovery_definition.allowed_tools == ("echo",)
    assert forced_tool_name is None


def test_required_tool_chain_reserves_recovery_budget():
    definition = AgentDefinition(
        agent_id="test",
        title="测试",
        description="验证必需工具前置链预算",
        mode=AgentMode.CHAT,
        prompt="读取证据后提交",
        tools=[
            AgentToolDescriptor(name="read", description="读取"),
            AgentToolDescriptor(name="search", description="检索"),
            AgentToolDescriptor(
                name="propose",
                description="提交",
                prerequisites=["read", "search"],
            ),
        ],
        required_tools={"propose"},
    )

    assert AgnoAgentExecutor._required_tool_chain(definition) == {
        "read",
        "search",
        "propose",
    }
