from __future__ import annotations

from agno.models.anthropic import Claude
from agno.models.base import Model
from agno.models.dashscope import DashScope
from agno.models.deepseek import DeepSeek
from agno.models.google import Gemini
from agno.models.mistral import MistralChat
from agno.models.ollama import Ollama
from agno.models.openai import OpenAIChat
from agno.models.openai.like import OpenAILike
from agno.models.openrouter import OpenRouter
from agno.models.xai import xAI

from openvideo.core.ai_models import AiModelConfiguration
from openvideo.llm.model_profile import ModelProfile


DEFAULT_DEEPSEEK_API_BASE = "https://api.deepseek.com"
DEFAULT_OPENROUTER_API_BASE = "https://openrouter.ai/api/v1"
DEFAULT_QWEN_API_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"
DEFAULT_XAI_API_BASE = "https://api.x.ai/v1"


def create_agent_model(
    config: AiModelConfiguration,
    profile: ModelProfile,
    *,
    reasoning_enabled: bool = False,
    forced_tool_name: str | None = None,
) -> Model:
    """业务 Agent 只传统一配置；Provider 构造和组合降级集中在这里。"""

    if (
        forced_tool_name
        and reasoning_enabled
        and profile.quirks.disable_named_tool_choice_when_reasoning
    ):
        reasoning_enabled = False
    common = {
        "id": profile.model,
        "api_key": config.api_key,
        "timeout": 120,
    }
    if profile.provider == "deepseek":
        return DeepSeek(
            **common,
            base_url=config.api_base or DEFAULT_DEEPSEEK_API_BASE,
            use_thinking=reasoning_enabled,
            max_tokens=12_000,
        )
    if profile.provider == "openai":
        return OpenAIChat(
            **common,
            base_url=config.api_base,
            max_tokens=12_000,
        )
    if profile.provider == "anthropic":
        client_params = {"base_url": config.api_base} if config.api_base else None
        return Claude(**common, client_params=client_params, max_tokens=12_000)
    if profile.provider == "google":
        return Gemini(**common)
    if profile.provider == "qwen":
        return DashScope(
            **common,
            base_url=config.api_base or DEFAULT_QWEN_API_BASE,
            enable_thinking=reasoning_enabled,
            max_tokens=12_000,
        )
    if profile.provider == "xai":
        return xAI(
            **common,
            base_url=config.api_base or DEFAULT_XAI_API_BASE,
            max_tokens=12_000,
        )
    if profile.provider == "mistral":
        return MistralChat(
            **common,
            endpoint=config.api_base,
            max_tokens=12_000,
        )
    if profile.provider == "openrouter":
        return OpenRouter(
            **common,
            base_url=config.api_base or DEFAULT_OPENROUTER_API_BASE,
            max_tokens=12_000,
        )
    if profile.provider == "ollama":
        return Ollama(
            id=profile.model,
            host=config.api_base,
            api_key=config.api_key,
            timeout=120,
        )
    return OpenAILike(
        **common,
        base_url=config.api_base,
        max_tokens=12_000,
    )


def agent_tool_choice(
    profile: ModelProfile,
    *,
    reasoning_enabled: bool,
    forced_tool_name: str | None = None,
) -> str | dict[str, object] | None:
    if forced_tool_name:
        return {
            "type": "function",
            "function": {"name": forced_tool_name},
        }
    if reasoning_enabled and profile.quirks.omit_tool_choice_when_reasoning:
        return None
    return "auto"
