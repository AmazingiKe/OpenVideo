from __future__ import annotations

from pydantic import BaseModel


PROVIDER_ALIASES = {
    "gemini": "google",
    "dashscope": "qwen",
    "alibaba": "qwen",
}
MODELS_DEV_PROVIDER_ALIASES = {
    "qwen": "alibaba",
}


class ModelAddress(BaseModel):
    provider: str
    model: str


def parse_model_address(model_name: str) -> ModelAddress:
    provider, separator, model = model_name.partition("/")
    if not separator:
        return ModelAddress(provider="openai-compatible", model=model_name)
    normalized_provider = PROVIDER_ALIASES.get(provider.lower(), provider.lower())
    return ModelAddress(provider=normalized_provider, model=model)


def models_dev_provider(provider: str) -> str:
    return MODELS_DEV_PROVIDER_ALIASES.get(provider, provider)
