from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock

from huggingface_hub import hf_hub_download, snapshot_download
from huggingface_hub.utils import tqdm

from openvideo.core.analysis_models import (
    TERMINAL_TRANSCRIPTION_MODEL_DOWNLOAD_STAGES,
    TRANSCRIPTION_MODEL_CATALOG,
    TranscriptionEngine,
    TranscriptionModelDescriptor,
    TranscriptionModelDownloadJob,
    TranscriptionModelDownloadStage,
    TranscriptionModelInstallationStatus,
    TranscriptionModelState,
    find_transcription_model,
)
from openvideo.core.identifiers import uuid7
from openvideo.settings import Settings


MODEL_MANIFEST_FILE_NAME = ".openvideo-model.json"
WHISPER_MODEL_FILE_NAME = "model.bin"
DOWNLOAD_START_PERCENT = 2
DOWNLOAD_FINISH_PERCENT = 99


class TranscriptionModelDownloadError(RuntimeError):
    """模型仓库无法解析或文件无法完整写入本地目录时抛出。"""


class TranscriptionModelManager:
    """管理独立于资料库的本地转录模型下载及安装状态。"""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._jobs: dict[str, TranscriptionModelDownloadJob] = {}
        self._latest_job_ids: dict[tuple[TranscriptionEngine, str], str] = {}
        self._tasks: set[asyncio.Task[None]] = set()
        self._lock = RLock()

    def list_models(self) -> list[TranscriptionModelState]:
        return [self.state(model) for model in TRANSCRIPTION_MODEL_CATALOG]

    def state(
        self,
        descriptor: TranscriptionModelDescriptor,
    ) -> TranscriptionModelState:
        job = self._latest_job(descriptor.engine, descriptor.model)
        if is_transcription_model_installed(
            descriptor,
            self.settings.models_root_directory,
        ):
            installation_status = TranscriptionModelInstallationStatus.INSTALLED
        elif job and job.stage not in TERMINAL_TRANSCRIPTION_MODEL_DOWNLOAD_STAGES:
            installation_status = TranscriptionModelInstallationStatus.DOWNLOADING
        elif job and job.stage == TranscriptionModelDownloadStage.FAILED:
            installation_status = TranscriptionModelInstallationStatus.FAILED
        else:
            installation_status = TranscriptionModelInstallationStatus.NOT_INSTALLED
        return TranscriptionModelState(
            **descriptor.model_dump(),
            installation_status=installation_status,
            download_job=job,
        )

    def create_download(
        self,
        engine: TranscriptionEngine,
        model: str,
    ) -> TranscriptionModelDownloadJob:
        descriptor = find_transcription_model(engine, model)
        if descriptor is None:
            raise TranscriptionModelDownloadError("转录模型不存在")
        if is_transcription_model_installed(
            descriptor,
            self.settings.models_root_directory,
        ):
            raise TranscriptionModelDownloadError(f"{descriptor.name} 已经安装")
        with self._lock:
            active_job = self._latest_job(engine, model)
            if (
                active_job
                and active_job.stage not in TERMINAL_TRANSCRIPTION_MODEL_DOWNLOAD_STAGES
            ):
                return active_job
            job = TranscriptionModelDownloadJob(
                job_id=f"model-download-{uuid7().hex}",
                engine=engine,
                model=model,
            )
            self._jobs[job.job_id] = job
            self._latest_job_ids[(engine, model)] = job.job_id
            return job.model_copy(deep=True)

    def start(self, job_id: str) -> None:
        task = asyncio.create_task(self._run(job_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def get(self, job_id: str) -> TranscriptionModelDownloadJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return job.model_copy(deep=True) if job else None

    async def close(self) -> None:
        if not self._tasks:
            return
        await asyncio.gather(*self._tasks, return_exceptions=True)

    async def _run(self, job_id: str) -> None:
        job = self.get(job_id)
        if job is None:
            return
        descriptor = find_transcription_model(job.engine, job.model)
        if descriptor is None:
            self._fail(job_id, "转录模型不存在")
            return
        self._update(
            job_id,
            stage=TranscriptionModelDownloadStage.RESOLVING,
            progress_percent=1,
            message="正在读取官方模型文件",
        )
        try:
            await asyncio.to_thread(
                download_transcription_model,
                descriptor,
                self.settings.models_root_directory,
                lambda downloaded_bytes, total_bytes: self._report_progress(
                    job_id,
                    downloaded_bytes,
                    total_bytes,
                ),
            )
        except Exception as error:
            self._fail(job_id, str(error) or "模型下载失败")
            return
        self._update(
            job_id,
            stage=TranscriptionModelDownloadStage.COMPLETE,
            progress_percent=100,
            message="模型已安装",
            error_message=None,
        )

    def _latest_job(
        self,
        engine: TranscriptionEngine,
        model: str,
    ) -> TranscriptionModelDownloadJob | None:
        with self._lock:
            job_id = self._latest_job_ids.get((engine, model))
            job = self._jobs.get(job_id) if job_id else None
            return job.model_copy(deep=True) if job else None

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
            stage=TranscriptionModelDownloadStage.DOWNLOADING,
            progress_percent=DOWNLOAD_START_PERCENT + downloaded_ratio * progress_range,
            downloaded_bytes=downloaded_bytes,
            total_bytes=total_bytes,
            message="正在下载模型文件",
        )

    def _fail(self, job_id: str, message: str) -> None:
        self._update(
            job_id,
            stage=TranscriptionModelDownloadStage.FAILED,
            message="模型下载失败",
            error_message=message,
        )

    def _update(self, job_id: str, **changes: object) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            self._jobs[job_id] = job.model_copy(
                update={**changes, "updated_at": datetime.now(UTC)}
            )


def transcription_model_directory(
    models_root_directory: Path,
    engine: TranscriptionEngine,
    model: str,
) -> Path:
    engine_directory = (models_root_directory / engine.value).resolve()
    model_directory = (engine_directory / model).resolve()
    if not model_directory.is_relative_to(engine_directory):
        raise TranscriptionModelDownloadError("转录模型目录无效")
    return model_directory


def is_transcription_model_installed(
    descriptor: TranscriptionModelDescriptor,
    models_root_directory: Path,
) -> bool:
    model_directory = transcription_model_directory(
        models_root_directory,
        descriptor.engine,
        descriptor.model,
    )
    manifest_path = model_directory / MODEL_MANIFEST_FILE_NAME
    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        return manifest.get("repository") == descriptor.repository
    return (
        descriptor.engine == TranscriptionEngine.FASTER_WHISPER
        and (model_directory / WHISPER_MODEL_FILE_NAME).is_file()
    )


def require_transcription_model_installed(
    descriptor: TranscriptionModelDescriptor,
    models_root_directory: Path,
) -> None:
    if not is_transcription_model_installed(descriptor, models_root_directory):
        raise TranscriptionModelDownloadError(
            f"{descriptor.name} 尚未安装，请先下载模型"
        )


def download_transcription_model(
    descriptor: TranscriptionModelDescriptor,
    models_root_directory: Path,
    progress_callback: Callable[[int, int], None],
) -> None:
    model_directory = transcription_model_directory(
        models_root_directory,
        descriptor.engine,
        descriptor.model,
    )
    model_directory.mkdir(parents=True, exist_ok=True)
    try:
        files = snapshot_download(
            descriptor.repository,
            local_dir=model_directory,
            dry_run=True,
        )
        if not isinstance(files, list):
            raise TranscriptionModelDownloadError("官方模型文件清单无效")
        total_bytes = sum(file.file_size for file in files)
        downloaded_bytes = 0
        progress_callback(downloaded_bytes, total_bytes)
        for file in files:
            hf_hub_download(
                descriptor.repository,
                file.filename,
                revision=file.commit_hash,
                local_dir=model_directory,
                tqdm_class=_progress_class(
                    downloaded_bytes,
                    total_bytes,
                    progress_callback,
                ),
            )
            downloaded_bytes += file.file_size
            progress_callback(downloaded_bytes, total_bytes)
    except TranscriptionModelDownloadError:
        raise
    except Exception as error:
        raise TranscriptionModelDownloadError(
            f"无法从 Hugging Face 下载 {descriptor.name}：{error}"
        ) from error
    manifest_path = model_directory / MODEL_MANIFEST_FILE_NAME
    temporary_manifest_path = manifest_path.with_suffix(".tmp")
    temporary_manifest_path.write_text(
        json.dumps(
            {
                "repository": descriptor.repository,
                "installed_at": datetime.now(UTC).isoformat(),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    temporary_manifest_path.replace(manifest_path)


def _progress_class(
    completed_bytes: int,
    total_bytes: int,
    progress_callback: Callable[[int, int], None],
) -> type[tqdm]:
    class DownloadProgress(tqdm):
        def update(self, amount: int | None = 1) -> bool | None:
            result = super().update(amount)
            progress_callback(
                min(completed_bytes + int(self.n), total_bytes),
                total_bytes,
            )
            return result

    return DownloadProgress
