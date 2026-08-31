from __future__ import annotations

import os
from pathlib import Path
from threading import RLock
from typing import Literal

from pydantic import BaseModel, Field

from openvideo.configuration import migrate_configuration_file


LEGACY_PAGE_SETTINGS_FILE_NAME = "page_setting.json"
PAGE_SETTINGS_FILE_NAME_TEMPLATE = "page-settings-{library_id}.json"
PAGE_SETTINGS_VERSION = 5


class MarkersPageSettings(BaseModel):
    """保存资料库内标记工作台的尺寸，不混入设备本地的可见性偏好。"""

    left_panel_size_percent: float = Field(default=24, ge=18, le=40)
    agent_panel_size_percent: float = Field(default=34, ge=24, le=48)


class PageSettingsDocument(BaseModel):
    """版本字段为后续页面设置迁移保留明确入口。"""

    version: Literal[PAGE_SETTINGS_VERSION] = PAGE_SETTINGS_VERSION
    markers: MarkersPageSettings = Field(default_factory=MarkersPageSettings)


class PageSettingsStore:
    """将页面偏好与当前资料库绑定，并保证一次保存不会留下半写文件。"""

    def __init__(
        self,
        config_directory: Path,
        library_id: str,
        legacy_path: Path | None = None,
    ) -> None:
        file_name = PAGE_SETTINGS_FILE_NAME_TEMPLATE.format(library_id=library_id)
        self.path = config_directory / file_name
        self._lock = RLock()
        if legacy_path is not None:
            # TODO(删除)：在 1.0 版本停止支持资料库内页面配置后删除迁移。
            migrate_configuration_file(legacy_path, self.path)

    def load_markers(self) -> MarkersPageSettings:
        with self._lock:
            try:
                document = PageSettingsDocument.model_validate_json(
                    self.path.read_text(encoding="utf-8")
                )
            except (OSError, ValueError):
                return MarkersPageSettings()
            return document.markers

    def save_markers(self, settings: MarkersPageSettings) -> MarkersPageSettings:
        document = PageSettingsDocument(markers=settings)
        temporary_path = self.path.with_name(f".{self.path.name}.tmp")
        with self._lock:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                temporary_path.write_text(
                    document.model_dump_json(indent=2),
                    encoding="utf-8",
                )
                os.replace(temporary_path, self.path)
            finally:
                temporary_path.unlink(missing_ok=True)
        return settings
