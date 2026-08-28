from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field


class Support(StrEnum):
    YES = "yes"
    NO = "no"
    UNKNOWN = "unknown"


class CapabilityOverride(StrEnum):
    AUTO = "auto"
    ENABLED = "enabled"
    DISABLED = "disabled"

    def support(self) -> Support:
        return {
            CapabilityOverride.AUTO: Support.UNKNOWN,
            CapabilityOverride.ENABLED: Support.YES,
            CapabilityOverride.DISABLED: Support.NO,
        }[self]


class CapabilityName(StrEnum):
    TOOLS = "tools"
    REASONING = "reasoning"
    VISION = "vision"
    STRUCTURED_OUTPUT = "structured_output"
    STREAMING_TOOLS = "streaming_tools"
    REASONING_TOOLS = "reasoning_tools"
    TOOL_CHOICE_AUTO = "tool_choice_auto"
    TOOL_CHOICE_REQUIRED = "tool_choice_required"
    TOOL_CHOICE_NAMED = "tool_choice_named"
    PARALLEL_TOOLS = "parallel_tools"
    VISION_TOOLS = "vision_tools"


CAPABILITY_NAMES = tuple(CapabilityName)


class CapabilitySource(StrEnum):
    USER_OVERRIDE = "user_override"
    RUNTIME_PROBE = "runtime_probe"
    LOCAL_OVERRIDE = "local_override"
    MODELS_DEV = "models_dev"
    LITELLM_METADATA = "litellm_metadata"
    UNKNOWN = "unknown"


class ModelCapabilities(BaseModel):
    tools: Support = Support.UNKNOWN
    reasoning: Support = Support.UNKNOWN
    vision: Support = Support.UNKNOWN
    structured_output: Support = Support.UNKNOWN
    streaming_tools: Support = Support.UNKNOWN
    reasoning_tools: Support = Support.UNKNOWN
    tool_choice_auto: Support = Support.UNKNOWN
    tool_choice_required: Support = Support.UNKNOWN
    tool_choice_named: Support = Support.UNKNOWN
    parallel_tools: Support = Support.UNKNOWN
    vision_tools: Support = Support.UNKNOWN

    def support(self, capability: CapabilityName) -> Support:
        return {
            CapabilityName.TOOLS: self.tools,
            CapabilityName.REASONING: self.reasoning,
            CapabilityName.VISION: self.vision,
            CapabilityName.STRUCTURED_OUTPUT: self.structured_output,
            CapabilityName.STREAMING_TOOLS: self.streaming_tools,
            CapabilityName.REASONING_TOOLS: self.reasoning_tools,
            CapabilityName.TOOL_CHOICE_AUTO: self.tool_choice_auto,
            CapabilityName.TOOL_CHOICE_REQUIRED: self.tool_choice_required,
            CapabilityName.TOOL_CHOICE_NAMED: self.tool_choice_named,
            CapabilityName.PARALLEL_TOOLS: self.parallel_tools,
            CapabilityName.VISION_TOOLS: self.vision_tools,
        }[capability]


class ModelCapabilityOverrides(BaseModel):
    tools: CapabilityOverride = CapabilityOverride.AUTO
    reasoning: CapabilityOverride = CapabilityOverride.AUTO
    vision: CapabilityOverride = CapabilityOverride.AUTO
    structured_output: CapabilityOverride = CapabilityOverride.AUTO
    streaming_tools: CapabilityOverride = CapabilityOverride.AUTO
    reasoning_tools: CapabilityOverride = CapabilityOverride.AUTO
    tool_choice_auto: CapabilityOverride = CapabilityOverride.AUTO
    tool_choice_required: CapabilityOverride = CapabilityOverride.AUTO
    tool_choice_named: CapabilityOverride = CapabilityOverride.AUTO
    parallel_tools: CapabilityOverride = CapabilityOverride.AUTO
    vision_tools: CapabilityOverride = CapabilityOverride.AUTO

    def support(self, capability: CapabilityName) -> Support:
        override = {
            CapabilityName.TOOLS: self.tools,
            CapabilityName.REASONING: self.reasoning,
            CapabilityName.VISION: self.vision,
            CapabilityName.STRUCTURED_OUTPUT: self.structured_output,
            CapabilityName.STREAMING_TOOLS: self.streaming_tools,
            CapabilityName.REASONING_TOOLS: self.reasoning_tools,
            CapabilityName.TOOL_CHOICE_AUTO: self.tool_choice_auto,
            CapabilityName.TOOL_CHOICE_REQUIRED: self.tool_choice_required,
            CapabilityName.TOOL_CHOICE_NAMED: self.tool_choice_named,
            CapabilityName.PARALLEL_TOOLS: self.parallel_tools,
            CapabilityName.VISION_TOOLS: self.vision_tools,
        }[capability]
        return override.support()


class ModelQuirks(BaseModel):
    disable_named_tool_choice_when_reasoning: bool = False
    omit_tool_choice_when_reasoning: bool = False
    preserve_reasoning_content: bool = False
    require_assistant_content: bool = False


class ModelLimits(BaseModel):
    context_tokens: int | None = Field(default=None, ge=1)
    max_output_tokens: int | None = Field(default=None, ge=1)


class ModelProfile(BaseModel):
    provider: str
    model: str
    capabilities: ModelCapabilities = Field(default_factory=ModelCapabilities)
    quirks: ModelQuirks = Field(default_factory=ModelQuirks)
    limits: ModelLimits = Field(default_factory=ModelLimits)
    capability_sources: dict[CapabilityName, CapabilitySource] = Field(
        default_factory=dict
    )

    def support(self, capability: CapabilityName) -> Support:
        return self.capabilities.support(capability)

    def source(self, capability: CapabilityName) -> CapabilitySource:
        return self.capability_sources.get(capability, CapabilitySource.UNKNOWN)
