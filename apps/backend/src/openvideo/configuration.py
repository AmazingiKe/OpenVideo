from __future__ import annotations

import os
import shutil
from pathlib import Path

from platformdirs import user_config_path


OPENVIDEO_CONFIG_DIRECTORY = user_config_path("OpenVideo", appauthor=False)
LEGACY_CONFIG_DIRECTORY = user_config_path("OpenVideo")


def migrate_configuration_file(source_path: Path, target_path: Path) -> None:
    """配置必须集中到用户配置目录，因此将旧位置的文件原子迁入新位置。"""

    if target_path.exists() or not source_path.is_file():
        return
    target_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = target_path.with_name(f".{target_path.name}.migration.tmp")
    try:
        shutil.copy2(source_path, temporary_path)
        os.replace(temporary_path, target_path)
        source_path.unlink()
    finally:
        temporary_path.unlink(missing_ok=True)
