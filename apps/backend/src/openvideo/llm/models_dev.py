from __future__ import annotations

import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from pydantic import BaseModel, Field

from openvideo.configuration import OPENVIDEO_CONFIG_DIRECTORY
from openvideo.llm.model_profile import ModelCapabilities, ModelLimits, Support
from openvideo.llm.models import models_dev_provider


MODELS_DEV_API_URL = "https://models.dev/api.json"
MODELS_DEV_CACHE_FILE_NAME = "models-dev-cache.json"
MODELS_DEV_TIMEOUT_SECONDS = 10


class ModelsDevCacheEntry(BaseModel):
    fetched_at: datetime
    model: dict[str, Any] | None = None


class ModelsDevCache(BaseModel):
    entries: dict[str, ModelsDevCacheEntry] = Field(default_factory=dict)


class ModelsDevProfile(BaseModel):
    capabilities: ModelCapabilities = Field(default_factory=ModelCapabilities)
    limits: ModelLimits = Field(default_factory=ModelLimits)


class ModelsDevCatalog:
    """models.dev 不可用时沿用本地条目，且目录缺项只表示未知。"""

    def __init__(
        self,
        cache_path: Path | None = None,
        api_url: str = MODELS_DEV_API_URL,
    ) -> None:
        self.cache_path = cache_path or (
            OPENVIDEO_CONFIG_DIRECTORY / MODELS_DEV_CACHE_FILE_NAME
        )
        self.api_url = api_url
        self._cache = self._load_cache()

    def profile(
        self,
        provider: str,
        model: str,
        *,
        refresh: bool = False,
    ) -> ModelsDevProfile:
        catalog_provider = models_dev_provider(provider)
        cache_key = f"{catalog_provider}/{model}"
        entry = self._cache.entries.get(cache_key)
        if refresh:
            downloaded = self._download_model(catalog_provider, model)
            if downloaded is not None:
                entry = ModelsDevCacheEntry(
                    fetched_at=datetime.now(UTC), model=downloaded
                )
                self._cache.entries[cache_key] = entry
                self._save_cache()
        if entry is None or entry.model is None:
            return ModelsDevProfile()
        return _models_dev_profile(entry.model)

    def _download_model(self, provider: str, model: str) -> dict[str, Any] | None:
        try:
            response = httpx.get(self.api_url, timeout=MODELS_DEV_TIMEOUT_SECONDS)
            response.raise_for_status()
            catalog = response.json()
        except (httpx.HTTPError, ValueError):
            return None
        provider_entry = catalog.get(provider)
        if not isinstance(provider_entry, dict):
            return None
        models = provider_entry.get("models")
        if not isinstance(models, dict):
            return None
        entry = models.get(model)
        return entry if isinstance(entry, dict) else None

    def _load_cache(self) -> ModelsDevCache:
        if not self.cache_path.is_file():
            return ModelsDevCache()
        try:
            return ModelsDevCache.model_validate_json(
                self.cache_path.read_text(encoding="utf-8")
            )
        except (OSError, ValueError):
            return ModelsDevCache()

    def _save_cache(self) -> None:
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = self.cache_path.with_suffix(".tmp")
        temporary_path.write_text(
            self._cache.model_dump_json(indent=2), encoding="utf-8"
        )
        os.replace(temporary_path, self.cache_path)


def _models_dev_profile(entry: dict[str, Any]) -> ModelsDevProfile:
    modalities = entry.get("modalities")
    input_modalities = (
        modalities.get("input", []) if isinstance(modalities, dict) else []
    )
    limits = entry.get("limit")
    limit_values = limits if isinstance(limits, dict) else {}
    return ModelsDevProfile(
        capabilities=ModelCapabilities(
            tools=_catalog_support(entry.get("tool_call")),
            reasoning=_catalog_support(entry.get("reasoning")),
            vision=(
                Support.YES
                if "image" in input_modalities
                else Support.UNKNOWN
            ),
            structured_output=_catalog_support(entry.get("structured_output")),
        ),
        limits=ModelLimits(
            context_tokens=_positive_integer(limit_values.get("context")),
            max_output_tokens=_positive_integer(limit_values.get("output")),
        ),
    )


def _catalog_support(value: object) -> Support:
    if value is True:
        return Support.YES
    return Support.UNKNOWN


def _positive_integer(value: object) -> int | None:
    return value if isinstance(value, int) and value > 0 else None
