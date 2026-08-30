"""管理视频公式识别模型的下载任务与安装状态。"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock

from openvideo.core.formula_models import (
    FORMULA_REQUIRED_FILES,
    FormulaModelState,
    formula_model_resources,
    is_formula_recognition_installed,
)
from openvideo.core.identifiers import uuid7
from openvideo.core.model_download_models import (
    ModelDownloadJob,
    ModelDownloadStage,
    ModelInstallationStatus,
    TERMINAL_MODEL_DOWNLOAD_STAGES,
    model_resource_is_installed,
)
from openvideo.model_download import ModelDownloadError, download_model_resources
from openvideo.settings import Settings


DOWNLOAD_START_PERCENT = 2
DOWNLOAD_FINISH_PERCENT = 99
_FORMULA_MODEL_DOWNLOAD_LOCK = RLock()


class FormulaModelDownloadError(RuntimeError):
    """公式模型已安装或所有官方下载源均不可用时抛出。"""


class FormulaModelManager:
    """公式模型不需要用户切换，安装后自动参与关键帧分析。"""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._job: ModelDownloadJob | None = None
        self._task: asyncio.Task[None] | None = None
        self._lock = RLock()

    def state(self) -> FormulaModelState:
        job = self.get()
        if is_formula_recognition_installed(self.settings.models_root_directory):
            installation_status = ModelInstallationStatus.INSTALLED
        elif job and job.stage not in TERMINAL_MODEL_DOWNLOAD_STAGES:
            installation_status = ModelInstallationStatus.DOWNLOADING
        elif job and job.stage == ModelDownloadStage.FAILED:
            installation_status = ModelInstallationStatus.FAILED
        else:
            installation_status = ModelInstallationStatus.NOT_INSTALLED
        return FormulaModelState(
            installation_status=installation_status,
            download_job=job,
        )

    def create_download(self) -> ModelDownloadJob:
        if is_formula_recognition_installed(self.settings.models_root_directory):
            raise FormulaModelDownloadError("视频公式识别模型已经安装")
        with self._lock:
            if self._job and self._job.stage not in TERMINAL_MODEL_DOWNLOAD_STAGES:
                return self._job.model_copy(deep=True)
            self._job = ModelDownloadJob(
                job_id=f"formula-model-download-{uuid7().hex}"
            )
            return self._job.model_copy(deep=True)

    def start(self, job_id: str) -> None:
        with self._lock:
            if self._job is None or self._job.job_id != job_id:
                raise FormulaModelDownloadError("公式模型下载任务不存在")
            if self._task is not None and not self._task.done():
                return
            self._task = asyncio.create_task(self._run(job_id))

    def get(self, job_id: str | None = None) -> ModelDownloadJob | None:
        with self._lock:
            if self._job is None or (job_id is not None and self._job.job_id != job_id):
                return None
            return self._job.model_copy(deep=True)

    async def close(self) -> None:
        if self._task is not None:
            await asyncio.gather(self._task, return_exceptions=True)

    async def _run(self, job_id: str) -> None:
        self._update(
            job_id,
            stage=ModelDownloadStage.RESOLVING,
            progress_percent=1,
            message="正在测速国内外官方模型源",
        )
        try:
            await asyncio.to_thread(
                download_formula_models,
                self.settings.models_root_directory,
                lambda downloaded_bytes, total_bytes: self._report_progress(
                    job_id,
                    downloaded_bytes,
                    total_bytes,
                ),
            )
        except Exception as error:
            self._update(
                job_id,
                stage=ModelDownloadStage.FAILED,
                message="公式模型下载失败",
                error_message=str(error) or "公式模型下载失败",
            )
            return
        self._update(
            job_id,
            stage=ModelDownloadStage.COMPLETE,
            progress_percent=100,
            message="公式模型已安装，关键帧分析将自动使用",
            error_message=None,
        )

    def _report_progress(
        self,
        job_id: str,
        downloaded_bytes: int,
        total_bytes: int,
    ) -> None:
        downloaded_ratio = downloaded_bytes / total_bytes if total_bytes else 0
        progress_range = DOWNLOAD_FINISH_PERCENT - DOWNLOAD_START_PERCENT
        self._update(
            job_id,
            stage=ModelDownloadStage.DOWNLOADING,
            progress_percent=DOWNLOAD_START_PERCENT + downloaded_ratio * progress_range,
            downloaded_bytes=downloaded_bytes,
            total_bytes=total_bytes,
            message="正在下载布局与公式识别模型",
        )

    def _update(self, job_id: str, **changes: object) -> None:
        with self._lock:
            if self._job is None or self._job.job_id != job_id:
                return
            self._job = self._job.model_copy(
                update={**changes, "updated_at": datetime.now(UTC)}
            )


def download_formula_models(
    models_root_directory: Path,
    progress_callback: Callable[[int, int], None],
) -> None:
    with _FORMULA_MODEL_DOWNLOAD_LOCK:
        resources = [
            resource
            for resource in formula_model_resources(models_root_directory)
            if not model_resource_is_installed(resource, FORMULA_REQUIRED_FILES)
        ]
        try:
            download_model_resources(resources, progress_callback)
        except ModelDownloadError as error:
            raise FormulaModelDownloadError(str(error)) from error
