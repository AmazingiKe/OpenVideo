import asyncio
from datetime import UTC, datetime
import logging
from threading import RLock

from openvideo.core.download_models import (
    DownloadJob,
    DownloadQuality,
    DownloadStage,
    DownloadTask,
    TERMINAL_DOWNLOAD_STAGES,
    INACTIVE_DOWNLOAD_STAGES,
)
from openvideo.core.identifiers import is_prefixed_uuid7, uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import MediaAsset, MediaAssetStatus
from openvideo.download_accounts import DownloadAccountExpired, DownloadAccountStore
from openvideo.settings import Settings
from openvideo.tools.downloader import (
    DOWNLOADING_MEDIA_MESSAGE,
    READING_METADATA_MESSAGE,
    DownloadFailure,
    DownloadMetadata,
    DownloadControl,
    DownloadPaused,
    download_video,
    is_authentication_failure,
)
from openvideo.tools.media import probe_media, validate_video_duration
from openvideo.tools.sources import SourceMatch


LOGGER = logging.getLogger(__name__)
MAX_CONCURRENT_DOWNLOADS = 2


class DownloadManager:
    """下载任务把长耗时外部进程与短生命周期 HTTP 请求隔离开。"""

    def __init__(
        self,
        library: MediaLibrary,
        settings: Settings,
        download_account_store: DownloadAccountStore,
    ) -> None:
        self.library = library
        self.settings = settings
        self.download_account_store = download_account_store
        self._jobs: dict[str, DownloadJob] = {
            job.job_id: job for job in library.list_download_jobs()
        }
        self._active_job_id_by_asset_id: dict[str, str] = {}
        for job in self._jobs.values():
            if job.stage == DownloadStage.PAUSED:
                self._active_job_id_by_asset_id[job.asset_id] = job.job_id
        self._lock = RLock()
        self._download_slots = asyncio.Semaphore(MAX_CONCURRENT_DOWNLOADS)
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._controls: dict[str, DownloadControl] = {}

    def create(
        self,
        source: SourceMatch,
        folder_id: str | None = None,
        assign_ready_folder: bool = False,
        video_quality: DownloadQuality = DownloadQuality.BEST,
        job_id: str | None = None,
    ) -> DownloadJob:
        if job_id is not None:
            if not is_prefixed_uuid7(job_id, "job-"):
                raise ValueError("下载任务标识无效")
            existing_job = self.get(job_id)
            if existing_job:
                existing_source = self.library.get(existing_job.asset_id)
                if (
                    not existing_source
                    or existing_source.source_url != source.normalized_url
                    or existing_job.video_quality != video_quality
                ):
                    raise ValueError("任务标识已用于其他下载")
                return existing_job
        if folder_id is not None:
            self.library.get_folder(folder_id)
        if source.source_video_id:
            existing_asset = self.library.find_by_source_video_id(
                source.platform,
                source.source_video_id,
            )
            if existing_asset:
                active_job = self._active_job_for(existing_asset.asset_id)
                if active_job:
                    return active_job
                if existing_asset.status == MediaAssetStatus.READY:
                    if assign_ready_folder and existing_asset.folder_id != folder_id:
                        existing_asset.folder_id = folder_id
                        self.library.save(existing_asset)
                    return self._completed_job(existing_asset, video_quality, job_id)
                existing_asset.folder_id = folder_id
                existing_asset.source_url = source.normalized_url
                existing_asset.status = MediaAssetStatus.PENDING
                existing_asset.error_message = None
                return self._create_download_job(existing_asset, video_quality, job_id)

        asset_id = str(uuid7())
        asset = MediaAsset(
            asset_id=asset_id,
            folder_id=folder_id,
            source_url=source.normalized_url,
            source_platform=source.platform,
            source_video_id=source.source_video_id,
        )
        return self._create_download_job(asset, video_quality, job_id)

    def _create_download_job(
        self,
        asset: MediaAsset,
        video_quality: DownloadQuality,
        job_id: str | None = None,
    ) -> DownloadJob:
        """素材与任务先共同落盘，避免轮询观察到没有持久化资源的任务。"""
        job_id = job_id or f"job-{uuid7().hex}"
        job = DownloadJob(
            job_id=job_id,
            asset_id=asset.asset_id,
            video_quality=video_quality,
        )
        self.library.save(asset)
        self.library.save_download_job(job)
        self._log_job_status(job)
        with self._lock:
            self._jobs[job_id] = job
            self._active_job_id_by_asset_id[asset.asset_id] = job_id
        return job.model_copy(deep=True)

    def create_batch(
        self,
        sources: list[SourceMatch],
        folder_id: str | None = None,
        assign_ready_folder: bool = False,
        video_quality: DownloadQuality = DownloadQuality.BEST,
        job_ids: list[str] | None = None,
    ) -> list[DownloadJob]:
        """为多个来源各建一个任务，返回与输入一一对应的任务列表。"""
        return [
            self.create(
                source,
                folder_id,
                assign_ready_folder,
                video_quality,
                job_ids[index] if job_ids else None,
            )
            for index, source in enumerate(sources)
        ]

    def start(self, job_id: str) -> None:
        with self._lock:
            current = self._tasks.get(job_id)
            if current and not current.done():
                return
            self._controls[job_id] = DownloadControl()
            task = asyncio.create_task(self._run(job_id))
            self._tasks[job_id] = task
            task.add_done_callback(
                lambda completed: self._discard_task(job_id, completed)
            )

    async def pause(self, job_id: str) -> DownloadTask:
        job = self.get(job_id)
        if job is None:
            raise KeyError(job_id)
        if job.stage in INACTIVE_DOWNLOAD_STAGES:
            return self._task_for(job)
        self._update_job(
            job_id,
            DownloadStage.PAUSING,
            job.progress_percent,
            "正在停止下载，保留续传分片",
        )
        control = self._controls.get(job_id)
        task = self._tasks.get(job_id)
        if task and job.stage == DownloadStage.PENDING:
            task.cancel()
        if control:
            await asyncio.to_thread(control.stop)
        if task:
            await asyncio.gather(task, return_exceptions=True)
        if control:
            # 子进程可能在首次停止检查之后才注册，确认退出后再公布暂停状态。
            await asyncio.to_thread(control.stop)
        with self._lock:
            current = self._jobs[job_id]
            if current.stage == DownloadStage.PAUSING:
                current.stage = DownloadStage.PAUSED
                current.message = "已暂停，继续时尝试续传"
                current.updated_at = datetime.now(UTC)
                self.library.save_download_job(current)
                self._active_job_id_by_asset_id[current.asset_id] = job_id
                asset = self.library.get(current.asset_id)
                if asset and asset.status != MediaAssetStatus.READY:
                    asset.status = MediaAssetStatus.PENDING
                    asset.error_message = None
                    self.library.save(asset)
            return self._task_for(current)

    def resume(self, job_id: str) -> DownloadTask:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise KeyError(job_id)
            if job.stage not in {DownloadStage.PAUSED, DownloadStage.FAILED}:
                raise ValueError("只有暂停或失败的下载可以重新开始")
            active = self._active_job_for(job.asset_id)
            if active and active.job_id != job_id:
                raise ValueError("该视频已有其他下载任务")
            asset = self.library.get(job.asset_id)
            if not asset:
                raise ValueError("素材已移除，请重新添加下载")
            if asset.status == MediaAssetStatus.READY:
                raise ValueError("视频已下载完成，无需重新开始")
            asset.status = MediaAssetStatus.PENDING
            asset.error_message = None
            self.library.save(asset)
            job.stage = DownloadStage.PENDING
            job.message = "等待继续下载"
            job.error_message = None
            job.updated_at = datetime.now(UTC)
            self.library.save_download_job(job)
            self._active_job_id_by_asset_id[job.asset_id] = job_id
            self.start(job_id)
            return self._task_for(job)

    def delete(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            if job.stage not in INACTIVE_DOWNLOAD_STAGES:
                raise ValueError("请先暂停下载，再删除任务记录")
            self.library.delete_download_job(job_id)
            self._jobs.pop(job_id)
            if self._active_job_id_by_asset_id.get(job.asset_id) == job_id:
                self._active_job_id_by_asset_id.pop(job.asset_id)

    def get(self, job_id: str) -> DownloadJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return job.model_copy(deep=True) if job else None

    def get_task(self, job_id: str) -> DownloadTask | None:
        job = self.get(job_id)
        return self._task_for(job) if job else None

    def list_tasks(self, limit: int) -> list[DownloadTask]:
        with self._lock:
            jobs = sorted(
                self._jobs.values(),
                key=lambda job: (job.created_at, job.job_id),
                reverse=True,
            )[:limit]
            snapshots = [job.model_copy(deep=True) for job in jobs]
        return [self._task_for(job) for job in snapshots]

    def has_active_jobs(self) -> bool:
        with self._lock:
            return any(
                job.stage not in INACTIVE_DOWNLOAD_STAGES for job in self._jobs.values()
            )

    async def cancel_assets(self, asset_ids: set[str]) -> bool:
        with self._lock:
            jobs = [
                job.model_copy(deep=True)
                for job in self._jobs.values()
                if job.asset_id in asset_ids
                and job.stage not in INACTIVE_DOWNLOAD_STAGES
            ]
            tasks = [
                self._tasks[job.job_id] for job in jobs if job.job_id in self._tasks
            ]
        if any(job.stage != DownloadStage.PENDING for job in jobs):
            # yt-dlp 和元数据探测运行在线程中，进程未退出前不能声称已停止。
            return False
        for job in jobs:
            self._fail(job.job_id, "素材已请求删除，下载任务已取消")
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        return all(task.done() for task in tasks)

    def _discard_task(self, job_id: str, completed: asyncio.Task[None]) -> None:
        with self._lock:
            if self._tasks.get(job_id) is completed:
                self._tasks.pop(job_id, None)
                self._controls.pop(job_id, None)

    async def _run(self, job_id: str) -> None:
        job = self.get(job_id)
        if not job:
            return
        control = self._controls.setdefault(job_id, DownloadControl())
        asset = self.library.get(job.asset_id)
        if not asset:
            self._fail(job_id, "找不到下载任务对应的媒体资源")
            return

        async with self._download_slots:
            current = self.get(job_id)
            if (
                not current
                or current.stage in INACTIVE_DOWNLOAD_STAGES
                or current.stage == DownloadStage.PAUSING
            ):
                return
            self._update_job(
                job_id,
                DownloadStage.READING_METADATA,
                1,
                READING_METADATA_MESSAGE,
            )
            asset.status = MediaAssetStatus.DOWNLOADING
            self.library.save(asset)
            try:
                with self.download_account_store.cookie_file(
                    asset.source_platform
                ) as cookie_source:
                    downloaded = await asyncio.to_thread(
                        download_video,
                        asset.source_url,
                        asset.source_platform,
                        self.library.media_directory(asset.asset_id),
                        self.settings.ffmpeg_path,
                        self.settings.ffmpeg_bin_dir,
                        lambda progress, message: self._update_job(
                            job_id,
                            DownloadStage.DOWNLOADING,
                            progress,
                            message,
                        ),
                        lambda message: self._update_stage_message(job_id, message),
                        lambda metadata: self._record_metadata(job_id, metadata),
                        video_quality=job.video_quality,
                        cookie_source=cookie_source,
                        staging_directory=self.library.download_temporary_directory(
                            job.asset_id
                        ),
                        download_proxy=self.settings.download_proxy,
                        control=control,
                    )
                control.checkpoint()
                self._update_job(
                    job_id,
                    DownloadStage.PROCESSING,
                    99,
                    "正在检查媒体文件",
                )
                asset = self.library.get(job.asset_id)
                if not asset:
                    raise DownloadFailure("媒体资源在下载期间被移除")
                probe = await asyncio.to_thread(
                    probe_media,
                    downloaded.playback_file,
                    self.settings.ffprobe_path,
                    self.settings.ffmpeg_bin_dir,
                )
                metadata = downloaded.metadata
                validate_video_duration(probe, metadata.duration_seconds)
                control.checkpoint()
                if not asset.source_video_id:
                    # 短链接等无法从地址识别 BV 号时，采用 yt-dlp 返回的视频 ID 用于去重。
                    asset.source_video_id = metadata.source_video_id
                asset.title = metadata.title
                asset.author_name = metadata.author_name
                asset.description = metadata.description
                asset.duration_seconds = (
                    probe.duration_seconds or metadata.duration_seconds
                )
                asset.width = probe.width or metadata.width
                asset.height = probe.height or metadata.height
                asset.video_codec = probe.video_codec
                asset.audio_codec = probe.audio_codec
                asset.playback_path = downloaded.playback_file.relative_to(
                    self.library.asset_directory(asset.asset_id)
                ).as_posix()
                asset.thumbnail_path = (
                    downloaded.thumbnail_file.relative_to(
                        self.library.asset_directory(asset.asset_id)
                    ).as_posix()
                    if downloaded.thumbnail_file
                    else None
                )
                asset.remote_thumbnail_url = metadata.thumbnail_url
                asset.status = MediaAssetStatus.READY
                asset.error_message = None
                self.library.save(asset)
                self._update_job(job_id, DownloadStage.COMPLETE, 100, "下载完成")
            except DownloadPaused:
                pass
            except DownloadAccountExpired as error:
                self._fail(job_id, str(error))
            except Exception as error:
                if is_authentication_failure(error):
                    self.download_account_store.mark_expired(asset.source_platform)
                self._fail(job_id, str(error) or "视频下载失败")
            finally:
                with self._lock:
                    active_job_id = self._active_job_id_by_asset_id.get(job.asset_id)
                    if active_job_id == job_id:
                        self._active_job_id_by_asset_id.pop(job.asset_id)

    def _update_stage_message(self, job_id: str, message: str) -> None:
        job = self.get(job_id)
        if not job or job.stage in TERMINAL_DOWNLOAD_STAGES:
            return
        stage = (
            DownloadStage.DOWNLOADING
            if message == DOWNLOADING_MEDIA_MESSAGE
            else job.stage
        )
        progress = max(job.progress_percent, 2)
        self._update_job(job_id, stage, progress, message)

    def _record_metadata(self, job_id: str, metadata: DownloadMetadata) -> None:
        job = self.get(job_id)
        if (
            not job
            or job.stage in INACTIVE_DOWNLOAD_STAGES
            or job.stage == DownloadStage.PAUSING
        ):
            return
        asset = self.library.get(job.asset_id)
        if asset:
            asset.source_video_id = metadata.source_video_id
            asset.title = metadata.title
            asset.author_name = metadata.author_name
            asset.description = metadata.description
            asset.duration_seconds = metadata.duration_seconds
            asset.width = metadata.width
            asset.height = metadata.height
            asset.remote_thumbnail_url = metadata.thumbnail_url
            self.library.save(asset)
        with self._lock:
            current_job = self._jobs.get(job_id)
            if not current_job or current_job.stage in TERMINAL_DOWNLOAD_STAGES:
                return
            current_job.updated_at = datetime.now(UTC)
            self.library.save_download_job(current_job)
            self._log_job_status(current_job, f"已识别视频：{metadata.title}")

    def _update_job(
        self,
        job_id: str,
        stage: DownloadStage,
        progress_percent: float,
        message: str,
        error_message: str | None = None,
    ) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if (
                not job
                or job.stage in INACTIVE_DOWNLOAD_STAGES
                or (
                    job.stage == DownloadStage.PAUSING
                    and stage != DownloadStage.PAUSING
                )
            ):
                return
            semantic_change = (
                stage != job.stage
                or message != job.message
                or error_message != job.error_message
            )
            job.stage = stage
            job.progress_percent = min(max(progress_percent, job.progress_percent), 100)
            job.message = message
            job.error_message = error_message
            job.updated_at = datetime.now(UTC)
            self.library.save_download_job(job)
            if semantic_change:
                self._log_job_status(job)

    def _fail(self, job_id: str, message: str) -> None:
        job = self.get(job_id)
        if (
            not job
            or job.stage in INACTIVE_DOWNLOAD_STAGES
            or job.stage == DownloadStage.PAUSING
        ):
            return
        asset = self.library.get(job.asset_id)
        if asset:
            asset.status = MediaAssetStatus.FAILED
            asset.error_message = message
            self.library.save(asset)
        self._update_job(
            job_id,
            DownloadStage.FAILED,
            job.progress_percent,
            "下载失败",
            message,
        )

    def _active_job_for(self, asset_id: str) -> DownloadJob | None:
        with self._lock:
            job_id = self._active_job_id_by_asset_id.get(asset_id)
            job = self._jobs.get(job_id) if job_id else None
            if not job or job.stage in TERMINAL_DOWNLOAD_STAGES:
                self._active_job_id_by_asset_id.pop(asset_id, None)
                return None
            return job.model_copy(deep=True)

    def _completed_job(
        self,
        asset: MediaAsset,
        video_quality: DownloadQuality,
        job_id: str | None = None,
    ) -> DownloadJob:
        job = DownloadJob(
            job_id=job_id or f"job-{uuid7().hex}",
            asset_id=asset.asset_id,
            video_quality=video_quality,
            stage=DownloadStage.COMPLETE,
            progress_percent=100,
            message="该视频已在媒体库中",
        )
        self.library.save_download_job(job)
        self._log_job_status(job)
        with self._lock:
            self._jobs[job.job_id] = job
        return job.model_copy(deep=True)

    def _task_for(self, job: DownloadJob) -> DownloadTask:
        asset = self.library.get(job.asset_id)
        return DownloadTask(
            **job.model_dump(),
            name=asset.title if asset else job.message,
        )

    @staticmethod
    def _log_job_status(job: DownloadJob, message: str | None = None) -> None:
        """状态历史只进入运行日志，避免把诊断明细持久化到资料库。"""

        LOGGER.info(
            "下载任务 %s：stage=%s progress=%.1f message=%s error=%s",
            job.job_id,
            job.stage,
            job.progress_percent,
            message or job.message,
            job.error_message or "无",
        )
