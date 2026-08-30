"""本地模型安装状态、下载任务与受管资源的数据契约。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path

from pydantic import BaseModel, Field


MODEL_MANIFEST_FILE_NAME = ".openvideo-model.json"


class ModelInstallationStatus(StrEnum):
    NOT_INSTALLED = "not_installed"
    DOWNLOADING = "downloading"
    INSTALLED = "installed"
    FAILED = "failed"


class ModelDownloadStage(StrEnum):
    PENDING = "pending"
    RESOLVING = "resolving"
    DOWNLOADING = "downloading"
    COMPLETE = "complete"
    FAILED = "failed"


TERMINAL_MODEL_DOWNLOAD_STAGES = {
    ModelDownloadStage.COMPLETE,
    ModelDownloadStage.FAILED,
}


class ModelDownloadJob(BaseModel):
    job_id: str
    stage: ModelDownloadStage = ModelDownloadStage.PENDING
    progress_percent: float = 0
    downloaded_bytes: int = 0
    total_bytes: int | None = None
    message: str = "等待下载"
    error_message: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


@dataclass(frozen=True)
class ModelResource:
    """一个可独立校验、断点恢复和切换下载源的官方模型仓库。"""

    repository: str
    directory: Path


@dataclass(frozen=True)
class ModelResourceFile:
    """锁定一次仓库解析得到的文件修订，避免下载期间主分支变化。"""

    filename: str
    file_size: int
    revision: str


def model_resource_is_installed(
    resource: ModelResource,
    required_files: tuple[str, ...] = (),
) -> bool:
    manifest_path = resource.directory / MODEL_MANIFEST_FILE_NAME
    if not manifest_path.is_file():
        return False
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return manifest.get("repository") == resource.repository and all(
        (resource.directory / filename).is_file() for filename in required_files
    )
