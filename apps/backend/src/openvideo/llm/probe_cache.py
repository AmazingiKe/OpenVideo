from __future__ import annotations

import hashlib
import os
from datetime import UTC, datetime, timedelta
from importlib.metadata import version
from pathlib import Path

from pydantic import BaseModel, Field

from openvideo.configuration import OPENVIDEO_CONFIG_DIRECTORY
from openvideo.llm.model_profile import CapabilityName, Support


PROBE_CACHE_FILE_NAME = "model-probe-cache.json"
PROBE_CACHE_TTL = timedelta(days=30)
PROBE_PROTOCOL = "openai-tools-v1"


class ProbeCacheEntry(BaseModel):
    provider: str
    api_base: str | None
    model: str
    sdk_version: str
    protocol: str
    tested_at: datetime
    capabilities: dict[CapabilityName, Support] = Field(default_factory=dict)


class ProbeCacheData(BaseModel):
    entries: dict[str, ProbeCacheEntry] = Field(default_factory=dict)


class ProbeCache:
    """真实探测绑定部署地址和协议，避免把网关差异误归因给模型名。"""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or OPENVIDEO_CONFIG_DIRECTORY / PROBE_CACHE_FILE_NAME
        self._data = self._load()

    def capabilities(
        self, provider: str, api_base: str | None, model: str
    ) -> dict[CapabilityName, Support]:
        entry = self._data.entries.get(self._key(provider, api_base, model))
        if entry is None or datetime.now(UTC) - entry.tested_at > PROBE_CACHE_TTL:
            return {}
        return dict(entry.capabilities)

    def record(
        self,
        provider: str,
        api_base: str | None,
        model: str,
        results: dict[CapabilityName, Support],
    ) -> None:
        cache_key = self._key(provider, api_base, model)
        current = self._data.entries.get(cache_key)
        capabilities = dict(current.capabilities) if current is not None else {}
        capabilities.update(results)
        self._data.entries[cache_key] = ProbeCacheEntry(
            provider=provider,
            api_base=api_base,
            model=model,
            sdk_version=version("litellm"),
            protocol=PROBE_PROTOCOL,
            tested_at=datetime.now(UTC),
            capabilities=capabilities,
        )
        self._save()

    def _key(self, provider: str, api_base: str | None, model: str) -> str:
        raw_key = "\n".join(
            [
                provider,
                api_base or "",
                model,
                version("litellm"),
                PROBE_PROTOCOL,
            ]
        )
        return hashlib.sha256(raw_key.encode()).hexdigest()

    def _load(self) -> ProbeCacheData:
        if not self.path.is_file():
            return ProbeCacheData()
        try:
            return ProbeCacheData.model_validate_json(
                self.path.read_text(encoding="utf-8")
            )
        except (OSError, ValueError):
            return ProbeCacheData()

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = self.path.with_suffix(".tmp")
        temporary_path.write_text(
            self._data.model_dump_json(indent=2), encoding="utf-8"
        )
        os.replace(temporary_path, self.path)
