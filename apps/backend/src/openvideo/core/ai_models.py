from __future__ import annotations

from ipaddress import ip_address
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import BaseModel, Field, field_validator, model_validator

from openvideo.core.identifiers import uuid7
from openvideo.llm.model_profile import ModelCapabilityOverrides


MODEL_ID_PREFIX = "model-"
MODEL_ID_HEX_LENGTH = 32
TEXT_INPUT_MODALITY = "text"
IMAGE_INPUT_MODALITY = "image"
AUDIO_INPUT_MODALITY = "audio"
VIDEO_INPUT_MODALITY = "video"
INPUT_MODALITIES = (
    TEXT_INPUT_MODALITY,
    IMAGE_INPUT_MODALITY,
    AUDIO_INPUT_MODALITY,
    VIDEO_INPUT_MODALITY,
)
LEGACY_VISION_FIELD = "supports_vision"
INPUT_MODALITIES_FIELD = "input_modalities"
LOCAL_MODEL_PROVIDERS = frozenset(
    {
        "llama_cpp",
        "lm_studio",
        "localai",
        "ollama",
        "ollama_chat",
        "vllm",
    }
)
LOOPBACK_HOST_NAMES = frozenset({"localhost", "localhost.localdomain"})
MODEL_ROUTE_PROVIDERS = frozenset(
    {
        "anthropic",
        "dashscope",
        "deepseek",
        "gemini",
        "google",
        "mistral",
        "openai",
        "openai-compatible",
        "openrouter",
        "qwen",
        "xai",
        *LOCAL_MODEL_PROVIDERS,
    }
)
API_HOST_PROVIDERS = (
    ("api.deepseek.com", "deepseek"),
    ("api.openai.com", "openai"),
    ("api.anthropic.com", "anthropic"),
    ("generativelanguage.googleapis.com", "gemini"),
    ("openrouter.ai", "openrouter"),
    ("dashscope.aliyuncs.com", "qwen"),
    ("api.x.ai", "xai"),
    ("api.mistral.ai", "mistral"),
)
MODEL_NAME_PROVIDERS = (
    ("deepseek-", "deepseek"),
    ("claude-", "anthropic"),
    ("gemini-", "gemini"),
    ("qwen", "qwen"),
    ("gpt-", "openai"),
    ("chatgpt-", "openai"),
    ("o1", "openai"),
    ("o3", "openai"),
    ("o4", "openai"),
    ("grok-", "xai"),
    ("mistral-", "mistral"),
    ("codestral-", "mistral"),
)

InputModality = Literal["text", "image", "audio", "video"]


class AiModelConfiguration(BaseModel):
    """保存一次可选的模型部署，使任务只需引用稳定标识而不接触密钥。"""

    model_id: str = Field(default_factory=lambda: f"{MODEL_ID_PREFIX}{uuid7().hex}")
    name: str = Field(min_length=1, max_length=100)
    litellm_model: str = Field(min_length=1, max_length=200)
    api_key: str | None = None
    api_base: str | None = None
    api_version: str | None = None
    input_modalities: list[InputModality] = Field(
        default_factory=lambda: [TEXT_INPUT_MODALITY]
    )
    capabilities: ModelCapabilityOverrides = Field(
        default_factory=ModelCapabilityOverrides
    )

    @model_validator(mode="before")
    @classmethod
    def migrate_legacy_vision_capability(cls, values: object) -> object:
        # TODO(删除)：在 1.0 版本停止支持旧模型配置后删除视觉字段迁移。
        if not isinstance(values, dict):
            return values
        if LEGACY_VISION_FIELD not in values or INPUT_MODALITIES_FIELD in values:
            return values
        migrated_values = dict(values)
        input_modalities = [TEXT_INPUT_MODALITY]
        if migrated_values.pop(LEGACY_VISION_FIELD) is True:
            input_modalities.append(IMAGE_INPUT_MODALITY)
        migrated_values[INPUT_MODALITIES_FIELD] = input_modalities
        return migrated_values

    @field_validator("model_id")
    @classmethod
    def validate_model_id(cls, model_id: str) -> str:
        hexadecimal = model_id.removeprefix(MODEL_ID_PREFIX)
        if (
            not model_id.startswith(MODEL_ID_PREFIX)
            or len(hexadecimal) != MODEL_ID_HEX_LENGTH
        ):
            raise ValueError("模型标识无效")
        try:
            parsed_identifier = UUID(hex=hexadecimal)
        except ValueError as error:
            raise ValueError("模型标识无效") from error
        if parsed_identifier.version != 7:
            raise ValueError("模型标识必须使用 UUIDv7")
        return model_id

    @field_validator("name", "litellm_model")
    @classmethod
    def normalize_required_text(cls, value: str) -> str:
        normalized_value = value.strip()
        if not normalized_value:
            raise ValueError("显示名称与模型名称不能为空")
        return normalized_value

    @field_validator("api_key", "api_base", "api_version")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized_value = value.strip()
        return normalized_value or None

    @model_validator(mode="after")
    def resolve_internal_model_route(self) -> "AiModelConfiguration":
        """设置页只填写服务商模型名，运行时路由前缀由配置统一推导。"""

        self.litellm_model = model_route(self.litellm_model, self.api_base)
        return self

    @field_validator("input_modalities")
    @classmethod
    def validate_input_modalities(
        cls,
        input_modalities: list[InputModality],
    ) -> list[InputModality]:
        if TEXT_INPUT_MODALITY not in input_modalities:
            raise ValueError("当前模型任务要求支持文本输入")
        if len(input_modalities) != len(set(input_modalities)):
            raise ValueError("模型输入模态不能重复")
        return [
            modality for modality in INPUT_MODALITIES if modality in input_modalities
        ]


class AiModelCollection(BaseModel):
    """集中保证持久化模型列表中的稳定标识不会产生歧义。"""

    ai_models: list[AiModelConfiguration] = Field(default_factory=list)

    @field_validator("ai_models")
    @classmethod
    def validate_unique_model_ids(
        cls,
        models: list[AiModelConfiguration],
    ) -> list[AiModelConfiguration]:
        model_ids = [model.model_id for model in models]
        if len(model_ids) != len(set(model_ids)):
            raise ValueError("AI 模型标识不能重复")
        return models


def online_api_configuration_error(model: AiModelConfiguration) -> str | None:
    """阻止 LLM 占用本机算力，同时允许旧配置被加载后由用户修正。"""

    provider = model.litellm_model.partition("/")[0].casefold()
    if provider in LOCAL_MODEL_PROVIDERS:
        return "大语言与视觉模型仅支持在线 API，不能使用本地推理供应商"
    if model.api_base is None:
        return None
    try:
        parsed_url = urlsplit(model.api_base)
        hostname_value = parsed_url.hostname
    except ValueError:
        return "自定义 API 地址必须是完整的 HTTPS 地址"
    if parsed_url.scheme.casefold() != "https" or hostname_value is None:
        return "在线 AI 模型的自定义 API 地址必须使用 HTTPS"
    hostname = hostname_value.casefold().rstrip(".")
    if hostname in LOOPBACK_HOST_NAMES:
        return "在线 AI 模型不能连接本机或局域网地址"
    try:
        address = ip_address(hostname)
    except ValueError:
        return None
    if (
        address.is_loopback
        or address.is_unspecified
        or address.is_private
        or address.is_link_local
    ):
        return "在线 AI 模型不能连接本机或局域网地址"
    return None


def is_online_api_model(model: AiModelConfiguration) -> bool:
    return online_api_configuration_error(model) is None


def model_route(model_name: str, api_base: str | None) -> str:
    """供应商前缀是内部路由细节，不要求用户在模型名称中重复填写。"""

    normalized_name = model_name.strip()
    routed_provider, separator, _ = normalized_name.partition("/")
    api_provider = _provider_from_api_base(api_base)
    if api_provider is not None:
        if separator and routed_provider.casefold() == api_provider:
            return normalized_name
        return f"{api_provider}/{normalized_name}"
    if separator and routed_provider.casefold() in MODEL_ROUTE_PROVIDERS:
        return normalized_name
    normalized_casefold = normalized_name.casefold()
    provider = next(
        (
            candidate_provider
            for prefix, candidate_provider in MODEL_NAME_PROVIDERS
            if normalized_casefold.startswith(prefix)
        ),
        None,
    )
    if provider is not None:
        return f"{provider}/{normalized_name}"
    return normalized_name if api_base is not None else f"openai/{normalized_name}"


def _provider_from_api_base(api_base: str | None) -> str | None:
    if api_base is None:
        return None
    try:
        hostname = urlsplit(api_base).hostname
    except ValueError:
        return None
    if hostname is None:
        return None
    normalized_hostname = hostname.casefold().rstrip(".")
    return next(
        (
            provider
            for suffix, provider in API_HOST_PROVIDERS
            if normalized_hostname == suffix
            or normalized_hostname.endswith(f".{suffix}")
        ),
        None,
    )
