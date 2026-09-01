from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock

from openvideo.core.model_download_models import (
    ModelDownloadStage,
    ModelInstallationStatus,
    ModelResource,
    TERMINAL_MODEL_DOWNLOAD_STAGES,
    model_resource_is_installed,
)
from openvideo.core.transcription_models import (
    TRANSCRIPTION_MODEL_CATALOG,
    TranscriptionEngine,
    TranscriptionModelDescriptor,
    TranscriptionModelDownloadJob,
    TranscriptionModelState,
    find_transcription_model,
)
from openvideo.core.identifiers import uuid7
from openvideo.model_download import ModelDownloadError, download_model_resources
from openvideo.settings import Settings


WHISPER_MODEL_FILE_NAME = "model.bin"
DOWNLOAD_START_PERCENT = 2
DOWNLOAD_FINISH_PERCENT = 99
QWEN_FORCED_ALIGNER_REPOSITORY = "Qwen/Qwen3-ForcedAligner-0.6B"
QWEN_FORCED_ALIGNER_DIRECTORY_NAME = "forced-aligner-0.6b"
SENSEVOICE_VAD_REPOSITORY = "funasr/fsmn-vad"
SENSEVOICE_VAD_DIRECTORY_NAME = "fsmn-vad"
SENSEVOICE_MODELSCOPE_REPOSITORY = "iic/SenseVoiceSmall"
SENSEVOICE_VAD_MODELSCOPE_REPOSITORY = "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"
_MODEL_DOWNLOAD_LOCK = RLock()


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
            installation_status = ModelInstallationStatus.INSTALLED
        elif job and job.stage not in TERMINAL_MODEL_DOWNLOAD_STAGES:
            installation_status = ModelInstallationStatus.DOWNLOADING
        elif job and job.stage == ModelDownloadStage.FAILED:
            installation_status = ModelInstallationStatus.FAILED
        else:
            installation_status = ModelInstallationStatus.NOT_INSTALLED
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
                and active_job.stage not in TERMINAL_MODEL_DOWNLOAD_STAGES
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
            stage=ModelDownloadStage.RESOLVING,
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
            stage=ModelDownloadStage.COMPLETE,
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
            stage=ModelDownloadStage.DOWNLOADING,
            progress_percent=DOWNLOAD_START_PERCENT + downloaded_ratio * progress_range,
            downloaded_bytes=downloaded_bytes,
            total_bytes=total_bytes,
            message="正在下载模型文件",
        )

    def _fail(self, job_id: str, message: str) -> None:
        self._update(
            job_id,
            stage=ModelDownloadStage.FAILED,
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
    resources = transcription_model_resources(descriptor, models_root_directory)
    return all(
        _resource_is_installed(resource, descriptor.engine)
        for resource in resources
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
    with _MODEL_DOWNLOAD_LOCK:
        _download_transcription_model_resources(
            descriptor,
            models_root_directory,
            progress_callback,
        )


def transcription_model_resources(
    descriptor: TranscriptionModelDescriptor,
    models_root_directory: Path,
) -> tuple[ModelResource, ...]:
    main_resource = ModelResource(
        repository=descriptor.repository,
        directory=transcription_model_directory(
            models_root_directory,
            descriptor.engine,
            descriptor.model,
        ),
        modelscope_repository=(
            SENSEVOICE_MODELSCOPE_REPOSITORY
            if descriptor.engine == TranscriptionEngine.SENSEVOICE
            else None
        ),
    )
    if descriptor.engine == TranscriptionEngine.QWEN3_ASR:
        companion = ModelResource(
            repository=QWEN_FORCED_ALIGNER_REPOSITORY,
            directory=transcription_model_directory(
                models_root_directory,
                descriptor.engine,
                QWEN_FORCED_ALIGNER_DIRECTORY_NAME,
            ),
        )
        return main_resource, companion
    if descriptor.engine == TranscriptionEngine.SENSEVOICE:
        companion = ModelResource(
            repository=SENSEVOICE_VAD_REPOSITORY,
            directory=transcription_model_directory(
                models_root_directory,
                descriptor.engine,
                SENSEVOICE_VAD_DIRECTORY_NAME,
            ),
            modelscope_repository=SENSEVOICE_VAD_MODELSCOPE_REPOSITORY,
        )
        return main_resource, companion
    return (main_resource,)


def _resource_is_installed(
    resource: ModelResource,
    engine: TranscriptionEngine,
) -> bool:
    return model_resource_is_installed(resource) or (
        engine == TranscriptionEngine.FASTER_WHISPER
        and (resource.directory / WHISPER_MODEL_FILE_NAME).is_file()
    )


def _download_transcription_model_resources(
    descriptor: TranscriptionModelDescriptor,
    models_root_directory: Path,
    progress_callback: Callable[[int, int], None],
) -> None:
    resources = [
        resource
        for resource in transcription_model_resources(descriptor, models_root_directory)
        if not _resource_is_installed(resource, descriptor.engine)
    ]
    try:
        download_model_resources(resources, progress_callback)
    except ModelDownloadError as error:
        raise TranscriptionModelDownloadError(str(error)) from error
    except Exception as error:
        raise TranscriptionModelDownloadError(
            f"无法从官方 ModelScope 或 Hugging Face 下载 {descriptor.name}：{error}"
        ) from error
