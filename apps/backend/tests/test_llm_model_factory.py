from __future__ import annotations

import pytest
from agno.models.deepseek import DeepSeek
from agno.models.message import Message

from openvideo.core.ai_models import AiModelConfiguration
from openvideo.llm.errors import ProviderRequestError
from openvideo.llm.model_factory import agent_tool_choice, create_agent_model
from openvideo.llm.model_profile import ModelProfile, ModelQuirks


def deepseek_profile() -> ModelProfile:
    return ModelProfile(
        provider="deepseek",
        model="deepseek-v4-flash-vision-exp",
        quirks=ModelQuirks(
            disable_named_tool_choice_when_reasoning=True,
            omit_tool_choice_when_reasoning=True,
            preserve_reasoning_content=True,
            require_assistant_content=True,
        ),
    )


def test_deepseek_thinking_does_not_force_named_tool():
    profile = deepseek_profile()
    config = AiModelConfiguration(
        name="DeepSeek V4",
        litellm_model="deepseek/deepseek-v4-flash-vision-exp",
        api_key="secret",
    )

    model = create_agent_model(
        config,
        profile,
        reasoning_enabled=True,
        forced_tool_name="report_probe",
    )

    assert isinstance(model, DeepSeek)
    assert model.use_thinking is False
    assert agent_tool_choice(profile, reasoning_enabled=True) is None


def test_deepseek_reasoning_content_preserved():
    model = DeepSeek(id="deepseek-v4-flash", api_key="secret")
    message = Message(
        role="assistant",
        content=None,
        reasoning_content="保留的推理内容",
    )

    formatted = model._format_message(message)

    assert formatted["reasoning_content"] == "保留的推理内容"
    assert formatted["content"] == ""


def test_agent_factory_rejects_local_provider():
    config = AiModelConfiguration(
        name="本地模型",
        litellm_model="ollama/qwen2.5-vl",
        api_base="http://127.0.0.1:11434",
    )
    profile = ModelProfile(provider="ollama", model="qwen2.5-vl")

    with pytest.raises(ProviderRequestError, match="仅支持在线 API"):
        create_agent_model(config, profile)
