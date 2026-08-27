from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field

from openvideo.llm.model_profile import ModelCapabilities, ModelQuirks, Support


QUIRKS_FILE_PATH = Path(__file__).with_name("quirks.yaml")


class LocalModelRules(BaseModel):
    capabilities: ModelCapabilities = Field(default_factory=ModelCapabilities)
    quirks: ModelQuirks = Field(default_factory=ModelQuirks)


class FamilyRule(LocalModelRules):
    provider: str
    model_prefix: str


class LocalQuirks:
    """Provider、模型族和精确模型规则在一个数据文件中按层合并。"""

    def __init__(self, path: Path = QUIRKS_FILE_PATH) -> None:
        values = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        self._providers = {
            str(key): LocalModelRules.model_validate(value)
            for key, value in _mapping(values, "providers").items()
        }
        self._families = [
            FamilyRule.model_validate(value)
            for value in _mapping(values, "families").values()
        ]
        self._models = {
            str(key): LocalModelRules.model_validate(value)
            for key, value in _mapping(values, "models").items()
        }

    def resolve(self, provider: str, model: str) -> LocalModelRules:
        matching_rules = [self._providers.get(provider)]
        matching_rules.extend(
            rule
            for rule in self._families
            if rule.provider == provider and model.startswith(rule.model_prefix)
        )
        matching_rules.append(self._models.get(f"{provider}/{model}"))
        capabilities = ModelCapabilities()
        quirks = ModelQuirks()
        for rule in matching_rules:
            if rule is None:
                continue
            capability_updates = {
                name: value
                for name, value in rule.capabilities.model_dump().items()
                if value != Support.UNKNOWN
            }
            capabilities = capabilities.model_copy(update=capability_updates)
            quirk_updates = {
                name: value
                for name, value in rule.quirks.model_dump().items()
                if value is True
            }
            quirks = quirks.model_copy(update=quirk_updates)
        return LocalModelRules(capabilities=capabilities, quirks=quirks)


def _mapping(values: dict[str, Any], key: str) -> dict[str, Any]:
    value = values.get(key, {})
    return value if isinstance(value, dict) else {}
