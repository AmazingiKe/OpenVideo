"""按已验证能力为未固定的助手模型角色选择稳定默认值。"""

from __future__ import annotations

from openvideo.core.agent_governance_models import AgentModelRole
from openvideo.core.ai_models import IMAGE_INPUT_MODALITY, AiModelConfiguration
from openvideo.llm.model_profile import CapabilityName, ModelProfile, Support


SUPPORT_PRIORITY = {
    Support.NO: 0,
    Support.UNKNOWN: 1,
    Support.YES: 2,
}


def select_automatic_model_id(
    role: AgentModelRole,
    models: list[AiModelConfiguration],
    profiles: dict[str, ModelProfile],
) -> str | None:
    """优先可信能力证据，并用注册顺序保证能力相同时结果稳定。"""

    candidates = [
        (index, model, profiles[model.model_id])
        for index, model in enumerate(models)
        if model.model_id in profiles
        and _supports_role(role, model, profiles[model.model_id])
    ]
    if not candidates:
        return None
    _, selected, _ = max(
        candidates,
        key=lambda candidate: _role_priority(role, candidate[2], candidate[0]),
    )
    return selected.model_id


def _supports_role(
    role: AgentModelRole,
    model: AiModelConfiguration,
    profile: ModelProfile,
) -> bool:
    if profile.support(CapabilityName.TOOLS) == Support.NO:
        return False
    if role != AgentModelRole.VISION:
        return True
    return (
        IMAGE_INPUT_MODALITY in model.input_modalities
        and profile.support(CapabilityName.VISION) != Support.NO
    )


def _role_priority(
    role: AgentModelRole,
    profile: ModelProfile,
    registration_index: int,
) -> tuple[int, ...]:
    tools = SUPPORT_PRIORITY[profile.support(CapabilityName.TOOLS)]
    stable_order = -registration_index
    if role == AgentModelRole.FAST:
        structured = SUPPORT_PRIORITY[
            profile.support(CapabilityName.STRUCTURED_OUTPUT)
        ]
        return tools, structured, stable_order
    if role == AgentModelRole.COMPLEX:
        reasoning = SUPPORT_PRIORITY[profile.support(CapabilityName.REASONING)]
        context_tokens = profile.limits.context_tokens or 0
        return reasoning, tools, context_tokens, stable_order
    vision_tools = SUPPORT_PRIORITY[
        profile.support(CapabilityName.VISION_TOOLS)
    ]
    vision = SUPPORT_PRIORITY[profile.support(CapabilityName.VISION)]
    return vision_tools, vision, tools, stable_order
