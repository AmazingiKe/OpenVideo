from __future__ import annotations

from typing import Literal
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
            raise ValueError("模型名称与 LiteLLM 模型不能为空")
        return normalized_value

    @field_validator("api_key", "api_base", "api_version")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized_value = value.strip()
        return normalized_value or None

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
