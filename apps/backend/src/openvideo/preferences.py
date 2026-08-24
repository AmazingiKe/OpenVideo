from __future__ import annotations

import os
from pathlib import Path

from pydantic import Field

from openvideo.configuration import (
    LEGACY_CONFIG_DIRECTORY,
    OPENVIDEO_CONFIG_DIRECTORY,
    migrate_configuration_file,
)
from openvideo.core.ai_models import AiModelCollection
from openvideo.core.transcription_models import TranscriptionOptions


PREFERENCES_FILE_NAME = "preferences.json"


class Preferences(AiModelCollection):
    current_library_path: str | None = None
    tools_directory: str | None = None
    models_directory: str | None = None
    default_transcription: TranscriptionOptions = Field(
        default_factory=TranscriptionOptions
    )


class PreferenceStore:
    """应用偏好不随资料库移动，因此保存在操作系统的用户配置目录。"""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or OPENVIDEO_CONFIG_DIRECTORY / PREFERENCES_FILE_NAME
        if path is None:
            # TODO(删除)：在 1.0 版本停止支持旧配置目录后删除双层目录迁移。
            legacy_path = LEGACY_CONFIG_DIRECTORY / PREFERENCES_FILE_NAME
            migrate_configuration_file(legacy_path, self.path)

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
