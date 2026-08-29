from openvideo.agent_model_roles import select_automatic_model_id
from openvideo.core.agent_governance_models import AgentModelRole
from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.identifiers import uuid7
from openvideo.llm.model_profile import (
    ModelCapabilities,
    ModelLimits,
    ModelProfile,
    Support,
)


def test_automatic_roles_prefer_verified_specialists_and_one_vision_model():
    general = model("通用模型")
    structured = model("快速结构化模型")
    reasoning = model("复杂推理模型")
    vision = model("视觉模型", image=True)
    models = [general, structured, reasoning, vision]
    profiles = {
        general.model_id: profile(tools=Support.YES),
        structured.model_id: profile(
            tools=Support.YES,
            structured_output=Support.YES,
        ),
        reasoning.model_id: profile(
            tools=Support.YES,
            reasoning=Support.YES,
            context_tokens=128_000,
        ),
        vision.model_id: profile(
            tools=Support.YES,
            vision=Support.YES,
            vision_tools=Support.YES,
        ),
    }

    assert (
        select_automatic_model_id(AgentModelRole.FAST, models, profiles)
        == structured.model_id
    )
    assert (
        select_automatic_model_id(AgentModelRole.COMPLEX, models, profiles)
        == reasoning.model_id
    )
    assert (
        select_automatic_model_id(AgentModelRole.VISION, models, profiles)
        == vision.model_id
    )


def test_automatic_roles_keep_registration_order_for_equal_capabilities():
    first = model("先注册")
    second = model("后注册")
    profiles = {
        first.model_id: profile(tools=Support.UNKNOWN),
        second.model_id: profile(tools=Support.UNKNOWN),
    }

    assert (
        select_automatic_model_id(
            AgentModelRole.FAST,
            [first, second],
            profiles,
        )
        == first.model_id
    )
    assert (
        select_automatic_model_id(
            AgentModelRole.VISION,
            [first, second],
            profiles,
        )
        is None
    )


def model(name: str, *, image: bool = False) -> AiModelConfiguration:
    return AiModelConfiguration(
        model_id=f"model-{uuid7().hex}",
        name=name,
        litellm_model=f"openai/{name}",
        input_modalities=["text", "image"] if image else ["text"],
    )


def profile(
    *,
    tools: Support,
    reasoning: Support = Support.UNKNOWN,
    structured_output: Support = Support.UNKNOWN,
    vision: Support = Support.UNKNOWN,
    vision_tools: Support = Support.UNKNOWN,
    context_tokens: int | None = None,
) -> ModelProfile:
    return ModelProfile(
        provider="openai",
        model="test",
        capabilities=ModelCapabilities(
            tools=tools,
            reasoning=reasoning,
            structured_output=structured_output,
            vision=vision,
            vision_tools=vision_tools,
        ),
        limits=ModelLimits(context_tokens=context_tokens),
    )
