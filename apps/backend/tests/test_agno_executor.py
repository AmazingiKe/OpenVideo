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
from openvideo.llm.events import LlmAgentEventType
from openvideo.llm.model_profile import ModelCapabilities, ModelProfile, Support


class EchoInput(BaseModel):
    text: str


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
