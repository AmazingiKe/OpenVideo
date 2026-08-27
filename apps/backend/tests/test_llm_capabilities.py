from __future__ import annotations

from pathlib import Path

from openvideo.core.ai_models import AiModelConfiguration
from openvideo.llm.capability_resolver import CapabilityResolver
from openvideo.llm.model_profile import (
    CapabilityName,
    CapabilitySource,
    Support,
)
from openvideo.llm.models_dev import ModelsDevCatalog
from openvideo.llm.probe_cache import ProbeCache


def resolver(tmp_path: Path) -> CapabilityResolver:
    return CapabilityResolver(
        models_dev=ModelsDevCatalog(tmp_path / "models-dev.json"),
        probe_cache=ProbeCache(tmp_path / "probes.json"),
    )


def test_user_force_enable_overrides_static_metadata(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(
        "openvideo.llm.capability_resolver.litellm.supports_function_calling",
        lambda **_kwargs: False,
    )
    model = AiModelConfiguration(
        name="实验模型",
        litellm_model="deepseek/deepseek-v5-preview",
        capabilities={"tools": "enabled"},
    )

    profile = resolver(tmp_path).resolve(model)

    assert profile.capabilities.tools == Support.YES
    assert profile.source(CapabilityName.TOOLS) == CapabilitySource.USER_OVERRIDE


def test_models_dev_tool_capability(tmp_path: Path, monkeypatch):
    catalog = ModelsDevCatalog(tmp_path / "models-dev.json")
    monkeypatch.setattr(
        catalog,
        "_download_model",
        lambda *_args: {
            "tool_call": True,
            "reasoning": False,
            "modalities": {"input": ["text", "image"], "output": ["text"]},
            "limit": {"context": 128_000, "output": 8_192},
        },
    )
    capability_resolver = CapabilityResolver(
        models_dev=catalog,
        probe_cache=ProbeCache(tmp_path / "probes.json"),
    )
    model = AiModelConfiguration(name="目录模型", litellm_model="openai/catalog")

    profile = capability_resolver.resolve(model, refresh_models_dev=True)

    assert profile.capabilities.tools == Support.YES
    assert profile.capabilities.vision == Support.YES
    assert profile.limits.context_tokens == 128_000
    assert profile.source(CapabilityName.TOOLS) == CapabilitySource.MODELS_DEV


def test_local_quirks_override_models_dev(tmp_path: Path, monkeypatch):
    catalog = ModelsDevCatalog(tmp_path / "models-dev.json")
    monkeypatch.setattr(
        catalog,
        "_download_model",
        lambda *_args: {
            "tool_call": False,
            "reasoning": False,
            "modalities": {"input": ["text"], "output": ["text"]},
        },
    )
    capability_resolver = CapabilityResolver(
        models_dev=catalog,
        probe_cache=ProbeCache(tmp_path / "probes.json"),
    )
    model = AiModelConfiguration(
        name="DeepSeek V4",
        litellm_model="deepseek/deepseek-v4-flash-vision-exp",
    )

    profile = capability_resolver.resolve(model, refresh_models_dev=True)

    assert profile.capabilities.tools == Support.YES
    assert profile.capabilities.reasoning == Support.YES
    assert profile.source(CapabilityName.TOOLS) == CapabilitySource.LOCAL_OVERRIDE


def test_runtime_probe_overrides_static_metadata(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(
        "openvideo.llm.capability_resolver.litellm.supports_function_calling",
        lambda **_kwargs: False,
    )
    capability_resolver = resolver(tmp_path)
    model = AiModelConfiguration(
        name="实验模型",
        litellm_model="deepseek/deepseek-v5-preview",
    )

    before_probe = capability_resolver.resolve(model)
    after_probe = capability_resolver.record_probe(
        model, {CapabilityName.TOOLS: Support.YES}
    )

    assert before_probe.capabilities.tools == Support.UNKNOWN
    assert after_probe.capabilities.tools == Support.YES
    assert after_probe.source(CapabilityName.TOOLS) == CapabilitySource.RUNTIME_PROBE


def test_unknown_experimental_model_can_probe(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(
        "openvideo.llm.capability_resolver.litellm.supports_function_calling",
        lambda **_kwargs: False,
    )
    model = AiModelConfiguration(
        name="未知实验模型",
        litellm_model="qwen/qwen4-coder-exp",
    )

    profile = resolver(tmp_path).resolve(model)

    assert profile.capabilities.tools == Support.UNKNOWN
