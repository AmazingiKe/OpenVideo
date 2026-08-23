from __future__ import annotations

import os
from pathlib import Path

from platformdirs import user_config_path
from openvideo.core.ai_models import AiModelCollection


PREFERENCES_FILE_NAME = "preferences.json"


class Preferences(AiModelCollection):
    current_library_path: str | None = None
    tools_directory: str | None = None
    models_directory: str | None = None


class PreferenceStore:
    """应用偏好不随资料库移动，因此保存在操作系统的用户配置目录。"""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or user_config_path("OpenVideo") / PREFERENCES_FILE_NAME

    def load(self) -> Preferences:
        if not self.path.is_file():
            return Preferences()
        try:
            return Preferences.model_validate_json(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return Preferences()

    def save(self, preferences: Preferences) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = self.path.with_suffix(".tmp")
        temporary_path.write_text(preferences.model_dump_json(indent=2), encoding="utf-8")
        os.replace(temporary_path, self.path)
