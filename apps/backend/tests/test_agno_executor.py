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
