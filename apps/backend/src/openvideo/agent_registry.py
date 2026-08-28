from dataclasses import dataclass
import json
from typing import Any

from openvideo.core.agent_runtime_models import (
    AgentCapability,
    AgentDefinition,
    AgentDefinitionAvailability,
    AgentMode,
    AgentRunCreate,
)
from openvideo.core.ai_models import AiModelConfiguration
from openvideo.llm.capability_resolver import CapabilityResolver
from openvideo.llm.model_profile import CapabilityName, ModelProfile, Support


class AgentServiceError(RuntimeError):
    """统一公开接口无法满足请求时返回稳定业务错误。"""

    def __init__(self, message: str, code: str = "agent_error") -> None:
        super().__init__(message)
        self.code = code


class AgentNotFoundError(AgentServiceError):
    def __init__(self, message: str) -> None:
        super().__init__(message, "agent_not_found")


class AgentConflictError(AgentServiceError):
    def __init__(self, message: str) -> None:
        super().__init__(message, "agent_conflict")


@dataclass(frozen=True)
class RegisteredAgent:
    definition: AgentDefinition
    tool_builder: Any
    approver: Any
    session_validator: Any | None
    run_definition: Any | None


class AgentDefinitionRegistry:
    """用途差异集中在注册项，API 和运行生命周期不做类型分派。"""

    def __init__(self, definitions: list[RegisteredAgent]) -> None:
        self._definitions = {
            registered.definition.agent_id: registered for registered in definitions
        }
        if len(self._definitions) != len(definitions):
            raise ValueError("Agent 标识不能重复")

    def require(self, agent_id: str) -> RegisteredAgent:
        registered = self._definitions.get(agent_id)
        if registered is None:
            raise AgentNotFoundError("Agent 定义不存在")
        return registered

    def values(self) -> list[RegisteredAgent]:
        return list(self._definitions.values())


def build_run_content(definition: AgentDefinition, request: AgentRunCreate) -> str:
    content = request.content.strip()
    if content:
        return content
    if definition.mode == AgentMode.TASK:
        return "执行任务：" + json.dumps(request.task_input, ensure_ascii=False)
    raise AgentServiceError("聊天消息不能为空")


def agent_availability(
    definition: AgentDefinition,
    models: list[AiModelConfiguration],
    capability_resolver: CapabilityResolver,
) -> AgentDefinitionAvailability:
    profiles = {
        model.model_id: capability_resolver.resolve(model) for model in models
    }
    compatible = [
        model.model_id
        for model in models
        if model_supports(definition, profiles[model.model_id])
    ]
    return AgentDefinitionAvailability(
        definition=definition,
        available=bool(compatible),
        compatible_model_ids=compatible,
        capability_model_ids={
            AgentCapability.TOOLS: [
                model.model_id
                for model in models
                if profiles[model.model_id].support(CapabilityName.TOOLS) != Support.NO
            ],
            AgentCapability.VISION: [
                model.model_id
                for model in models
                if profiles[model.model_id].support(CapabilityName.VISION)
                != Support.NO
            ],
            AgentCapability.LONG_CONTEXT: [
                model.model_id
                for model in models
                if has_context_capacity(definition, profiles[model.model_id])
            ],
        },
        unavailable_reason=None if compatible else "没有满足能力要求的模型",
    )


def model_supports(definition: AgentDefinition, profile: ModelProfile) -> bool:
    if (
        AgentCapability.TOOLS in definition.required_capabilities
        and profile.support(CapabilityName.TOOLS) == Support.NO
    ):
        return False
    if (
        AgentCapability.VISION in definition.required_capabilities
        and profile.support(CapabilityName.VISION) == Support.NO
    ):
        return False
    return has_context_capacity(definition, profile)


def has_context_capacity(
    definition: AgentDefinition, profile: ModelProfile
) -> bool:
    context_tokens = profile.limits.context_tokens
    return (
        context_tokens is None or context_tokens >= definition.minimum_context_tokens
    )


def validate_model(definition: AgentDefinition, profile: ModelProfile) -> None:
    if not model_supports(definition, profile):
        raise AgentServiceError(
            "所选模型不满足 Agent 的能力要求", "capability_unavailable"
        )
