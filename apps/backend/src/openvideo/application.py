import asyncio
from datetime import UTC, datetime
from threading import RLock

from openvideo.core.analysis_models import (
    AnalysisJob,
    AnalysisStage,
    TERMINAL_ANALYSIS_STAGES,
    Transcript,
)
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.models import (
    DownloadJob,
    DownloadStage,
    MediaAsset,
    MediaAssetStatus,
    TERMINAL_DOWNLOAD_STAGES,
)
from openvideo.settings import Settings
from openvideo.tools.downloader import DownloadFailure, download_video
from openvideo.tools.media import probe_media
from openvideo.tools.sources import SourceMatch
from openvideo.tools.thumbnails import generate_thumbnail_sprite
from openvideo.tools.transcribe import FasterWhisperTranscriber, transcribe_media


class DownloadManager:
    """下载任务把长耗时外部进程与短生命周期 HTTP 请求隔离开。"""

    def __init__(self, library: MediaLibrary, settings: Settings) -> None:
        self.library = library
        self.settings = settings
        self._jobs: dict[str, DownloadJob] = {}
        self._active_job_id_by_asset_id: dict[str, str] = {}
        self._lock = RLock()
        self._download_lock = asyncio.Lock()

    def create(self, source: SourceMatch) -> DownloadJob:
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
                    return self._completed_job(existing_asset.asset_id)

        asset_id = f"asset-{uuid7().hex}"
        job_id = f"job-{uuid7().hex}"
        asset = MediaAsset(
            asset_id=asset_id,
            source_url=source.normalized_url,
            source_platform=source.platform,
            source_video_id=source.source_video_id,
        )
        job = DownloadJob(job_id=job_id, asset_id=asset_id)
        self.library.save(asset)
        with self._lock:
            self._jobs[job_id] = job
            self._active_job_id_by_asset_id[asset_id] = job_id
        return job.model_copy(deep=True)

    def create_batch(self, sources: list[SourceMatch]) -> list[DownloadJob]:
        """为多个来源各建一个任务，返回与输入一一对应的任务列表。"""
        return [self.create(source) for source in sources]

    def start(self, job_id: str) -> None:
        asyncio.create_task(self._run(job_id))

    def get(self, job_id: str) -> DownloadJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return job.model_copy(deep=True) if job else None

    async def _run(self, job_id: str) -> None:
        job = self.get(job_id)
        if not job:
            return
        asset = self.library.get(job.asset_id)
        if not asset:
            self._fail(job_id, "找不到下载任务对应的媒体资源")
            return

        async with self._download_lock:
            self._update_job(
                job_id,
                DownloadStage.READING_METADATA,
                1,
                "正在读取视频信息",
            )
            asset.status = MediaAssetStatus.DOWNLOADING
            self.library.save(asset)
            try:
                downloaded = await asyncio.to_thread(
                    download_video,
                    asset.source_url,
                    asset.source_platform,
                    self.library.asset_directory(asset.asset_id),
                    self.settings.ffmpeg_path,
                    self.settings.ffmpeg_bin_dir,
                    lambda progress, message: self._update_job(
                        job_id,
                        DownloadStage.DOWNLOADING,
                        progress,
                        message,
                    ),
                    lambda message: self._update_stage_message(job_id, message),
                )
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
                if not asset.source_video_id:
                    # 短链接等无法从地址识别 BV 号时，采用 yt-dlp 返回的视频 ID 用于去重。
                    asset.source_video_id = metadata.source_video_id
                asset.title = metadata.title
                asset.author_name = metadata.author_name
                asset.description = metadata.description
                asset.duration_seconds = probe.duration_seconds or metadata.duration_seconds
                asset.width = probe.width or metadata.width
                asset.height = probe.height or metadata.height
                asset.video_codec = probe.video_codec
                asset.audio_codec = probe.audio_codec
                asset.playback_path = downloaded.playback_file.name
                asset.thumbnail_path = (
                    downloaded.thumbnail_file.name
                    if downloaded.thumbnail_file
                    else None
                )
                asset.remote_thumbnail_url = metadata.thumbnail_url
                storyboard = await asyncio.to_thread(
                    generate_thumbnail_sprite,
                    downloaded.playback_file,
                    self.library.asset_directory(asset.asset_id),
                    asset.duration_seconds,
                    self.settings.ffmpeg_path,
                    self.settings.ffmpeg_bin_dir,
                )
                if storyboard:
                    asset.thumbnail_sprite_path = storyboard.sprite_path
                    asset.thumbnail_tile_width = storyboard.tile_width
                    asset.thumbnail_tile_height = storyboard.tile_height
                    asset.thumbnail_interval_seconds = storyboard.interval_seconds
                    asset.thumbnail_columns = storyboard.columns
                    asset.thumbnail_total_tiles = storyboard.total_tiles
                asset.status = MediaAssetStatus.READY
                asset.error_message = None
                self.library.save(asset)
                self._update_job(job_id, DownloadStage.COMPLETE, 100, "下载完成")
            except Exception as error:
                self._fail(job_id, str(error) or "视频下载失败")
            finally:
                with self._lock:
                    self._active_job_id_by_asset_id.pop(job.asset_id, None)

    def _update_stage_message(self, job_id: str, message: str) -> None:
        job = self.get(job_id)
        if not job or job.stage in TERMINAL_DOWNLOAD_STAGES:
            return
        stage = (
            DownloadStage.DOWNLOADING
            if job.stage == DownloadStage.READING_METADATA
            else job.stage
        )
        progress = max(job.progress_percent, 2)
        self._update_job(job_id, stage, progress, message)

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
            if not job or job.stage in TERMINAL_DOWNLOAD_STAGES:
                return
            job.stage = stage
            job.progress_percent = min(max(progress_percent, job.progress_percent), 100)
            job.message = message
            job.error_message = error_message
            job.updated_at = datetime.now(UTC)

    def _fail(self, job_id: str, message: str) -> None:
        job = self.get(job_id)
        if not job:
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
            return job.model_copy(deep=True) if job else None

    @staticmethod
    def _completed_job(asset_id: str) -> DownloadJob:
        return DownloadJob(
            job_id=f"job-{uuid7().hex}",
            asset_id=asset_id,
            stage=DownloadStage.COMPLETE,
            progress_percent=100,
            message="该视频已在媒体库中",
        )


class AnalysisError(RuntimeError):
    """分析任务无法创建或执行时抛出。"""


class AnalysisManager:
    """分析任务把转写等长耗时计算与短生命周期 HTTP 请求隔离开。"""

    def __init__(self, library: MediaLibrary, settings: Settings) -> None:
        self.library = library
        self.settings = settings
        self._jobs: dict[str, AnalysisJob] = {}
        self._active_job_id_by_asset_id: dict[str, str] = {}
        self._lock = RLock()
        self._analysis_lock = asyncio.Lock()

    def create(self, asset_id: str) -> AnalysisJob:
        asset = self.library.get(asset_id)
        if not asset or asset.status != MediaAssetStatus.READY:
            raise AnalysisError("视频尚未就绪，无法分析")
        active_job = self._active_job_for(asset_id)
        if active_job:
            return active_job
        if self.library.load_transcript(asset_id):
            return self._completed_job(asset_id)

        job_id = f"analysis-{uuid7().hex}"
        job = AnalysisJob(job_id=job_id, asset_id=asset_id)
        with self._lock:
            self._jobs[job_id] = job
            self._active_job_id_by_asset_id[asset_id] = job_id
        return job.model_copy(deep=True)

    def start(self, job_id: str) -> None:
        asyncio.create_task(self._run(job_id))

    def get(self, job_id: str) -> AnalysisJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return job.model_copy(deep=True) if job else None

    def transcript(self, asset_id: str) -> Transcript | None:
        return self.library.load_transcript(asset_id)

    async def _run(self, job_id: str) -> None:
        job = self.get(job_id)
        if not job:
            return
        asset = self.library.get(job.asset_id)
        if not asset:
            self._fail(job_id, "找不到分析任务对应的媒体资源")
            return

        async with self._analysis_lock:
            try:
                playback = self.library.resolve_asset_file(asset, asset.playback_path)
                if not playback:
                    raise AnalysisError("视频文件不存在")
                self._update_job(job_id, AnalysisStage.EXTRACTING_AUDIO, 5, "正在提取音频")
                work_directory = self.library.asset_directory(asset.asset_id) / ".analysis"
                transcript = await asyncio.to_thread(
                    transcribe_media,
                    playback,
                    asset.asset_id,
                    asset.source_url,
                    work_directory,
                    self.settings.ffmpeg_path,
                    self.settings.ffmpeg_bin_dir,
                    self._transcriber(),
                )
                self._update_job(
                    job_id,
                    AnalysisStage.TRANSCRIBING,
                    60,
                    "正在将音频转写为文字",
                )
                self.library.save_transcript(transcript)
                self._update_job(job_id, AnalysisStage.COMPLETE, 100, "分析完成")
            except Exception as error:
                self._fail(job_id, str(error) or "分析失败")
            finally:
                with self._lock:
                    self._active_job_id_by_asset_id.pop(job.asset_id, None)

    def _transcriber(self) -> FasterWhisperTranscriber:
        return FasterWhisperTranscriber(
            model_size=self.settings.whisper_model,
            language=self.settings.whisper_language,
            compute_type=self.settings.whisper_compute_type,
        )

    def _update_job(
        self,
        job_id: str,
        stage: AnalysisStage,
        progress_percent: float,
        message: str,
        error_message: str | None = None,
    ) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job or job.stage in TERMINAL_ANALYSIS_STAGES:
                return
            job.stage = stage
            job.progress_percent = min(max(progress_percent, job.progress_percent), 100)
            job.message = message
            job.error_message = error_message
            job.updated_at = datetime.now(UTC)

    def _fail(self, job_id: str, message: str) -> None:
        job = self.get(job_id)
        if not job:
            return
        self._update_job(
            job_id,
            AnalysisStage.FAILED,
            job.progress_percent,
            "分析失败",
            message,
        )

    def _active_job_for(self, asset_id: str) -> AnalysisJob | None:
        with self._lock:
            job_id = self._active_job_id_by_asset_id.get(asset_id)
            job = self._jobs.get(job_id) if job_id else None
            return job.model_copy(deep=True) if job else None

    @staticmethod
    def _completed_job(asset_id: str) -> AnalysisJob:
        return AnalysisJob(
            job_id=f"analysis-{uuid7().hex}",
            asset_id=asset_id,
            stage=AnalysisStage.COMPLETE,
            progress_percent=100,
            message="该视频已完成文字提取",
        )
