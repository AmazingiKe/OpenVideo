from __future__ import annotations

import litellm

from openvideo.core.ai_models import AiModelConfiguration
from openvideo.llm.model_profile import (
    CAPABILITY_NAMES,
    CapabilityName,
    CapabilitySource,
    ModelCapabilities,
    ModelProfile,
    Support,
)
from openvideo.llm.models import parse_model_address
from openvideo.llm.models_dev import ModelsDevCatalog
from openvideo.llm.probe_cache import ProbeCache
from openvideo.llm.quirks import LocalQuirks


class CapabilityResolver:
    """按证据优先级生成唯一 ModelProfile，未知证据绝不覆盖已确认结果。"""

    def __init__(
        self,
        models_dev: ModelsDevCatalog | None = None,
        local_quirks: LocalQuirks | None = None,
        probe_cache: ProbeCache | None = None,
    ) -> None:
        self.models_dev = models_dev or ModelsDevCatalog()
        self.local_quirks = local_quirks or LocalQuirks()
        self.probe_cache = probe_cache or ProbeCache()

    def resolve(
        self, model: AiModelConfiguration, *, refresh_models_dev: bool = False
    ) -> ModelProfile:
        address = parse_model_address(model.litellm_model)
        local = self.local_quirks.resolve(address.provider, address.model)
        catalog = self.models_dev.profile(
            address.provider,
            address.model,
            refresh=refresh_models_dev,
        )
        probed = self.probe_cache.capabilities(
            address.provider, model.api_base, address.model
        )
        values: dict[str, Support] = {}
        sources: dict[CapabilityName, CapabilitySource] = {}
        for capability in CAPABILITY_NAMES:
            support, source = self._resolve_capability(
                model, capability, probed, local.capabilities, catalog.capabilities
            )
            values[capability.value] = support
            sources[capability] = source
        return ModelProfile(
            provider=address.provider,
            model=address.model,
            capabilities=ModelCapabilities.model_validate(values),
            quirks=local.quirks,
            limits=catalog.limits,
            capability_sources=sources,
        )

    def record_probe(
        self,
        model: AiModelConfiguration,
        results: dict[CapabilityName, Support],
    ) -> ModelProfile:
        address = parse_model_address(model.litellm_model)
        self.probe_cache.record(
            address.provider, model.api_base, address.model, results
        )
        return self.resolve(model)

    def _resolve_capability(
        self,
        model: AiModelConfiguration,
        capability: CapabilityName,
        probed: dict[CapabilityName, Support],
        local: ModelCapabilities,
        catalog: ModelCapabilities,
    ) -> tuple[Support, CapabilitySource]:
        configured = getattr(model.capabilities, capability.value).support()
        candidates = (
            (configured, CapabilitySource.USER_OVERRIDE),
            (probed.get(capability, Support.UNKNOWN), CapabilitySource.RUNTIME_PROBE),
            (getattr(local, capability.value), CapabilitySource.LOCAL_OVERRIDE),
            (getattr(catalog, capability.value), CapabilitySource.MODELS_DEV),
            (
                self._litellm_support(model, capability),
                CapabilitySource.LITELLM_METADATA,
            ),
        )
        return (
            next(
                (support, source)
                for support, source in candidates
                if support != Support.UNKNOWN
            )
            if any(support != Support.UNKNOWN for support, _ in candidates)
            else (
                Support.UNKNOWN,
                CapabilitySource.UNKNOWN,
            )
        )

    @staticmethod
    def _litellm_support(
        model: AiModelConfiguration, capability: CapabilityName
    ) -> Support:
        if capability != CapabilityName.TOOLS:
            return Support.UNKNOWN
        try:
            supported = litellm.supports_function_calling(model=model.litellm_model)
        except Exception:
            return Support.UNKNOWN
        return Support.YES if supported is True else Support.UNKNOWN
