import asyncio
from datetime import UTC, datetime
from threading import RLock

from openvideo.core.analysis_models import (
    AnalysisCapability,
    AnalysisJob,
    AnalysisMode,
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
    MediaMarker,
    MediaSegment,
    TERMINAL_DOWNLOAD_STAGES,
)
from openvideo.settings import Settings
from openvideo.tools.analysis_pipeline import build_segments
from openvideo.tools.downloader import DownloadFailure, download_video
from openvideo.tools.media import probe_media
from openvideo.tools.sources import SourceMatch
from openvideo.tools.thumbnails import generate_thumbnail_sprite
from openvideo.tools.transcribe import FasterWhisperTranscriber, transcribe_media
from openvideo.tools.vision import OpenAiCompatibleVision


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

    def create(
        self,
        asset_id: str,
        mode: AnalysisMode,
        marker_ids: list[str],
        force: bool,
    ) -> AnalysisJob:
        asset = self.library.get(asset_id)
        if not asset or asset.status != MediaAssetStatus.READY:
            raise AnalysisError("视频尚未就绪，无法分析")
        active_job = self._active_job_for(asset_id)
        if active_job:
            return active_job
        resolved_marker_ids = self._validated_marker_ids(asset_id, mode, marker_ids)
        existing_segments = self.library.load_segments(asset_id)
        has_full_timeline = any(not segment.marker_ids for segment in existing_segments)
        if mode == AnalysisMode.FULL and has_full_timeline and not force:
            return self._completed_job(asset_id, mode, [])

        job_id = f"analysis-{uuid7().hex}"
        job = AnalysisJob(
            job_id=job_id,
            asset_id=asset_id,
            mode=mode,
            marker_ids=resolved_marker_ids,
        )
        with self._lock:
            self._jobs[job_id] = job
            self._active_job_id_by_asset_id[asset_id] = job_id
        self.library.save_analysis_job(job)
        return job.model_copy(deep=True)

    def start(self, job_id: str) -> None:
        asyncio.create_task(self._run(job_id))

    def restore(self) -> None:
        """服务重启后恢复未完成任务，复用已经落盘的转写与事件产物。"""
        for saved_job in self.library.load_analysis_jobs():
            job = saved_job.model_copy(deep=True)
            if job.stage not in TERMINAL_ANALYSIS_STAGES:
                job.stage = AnalysisStage.PENDING
                job.message = "等待恢复分析"
                job.error_message = None
                with self._lock:
                    self._active_job_id_by_asset_id[job.asset_id] = job.job_id
            with self._lock:
                self._jobs[job.job_id] = job
            if job.stage == AnalysisStage.PENDING:
                self.start(job.job_id)

    def get(self, job_id: str) -> AnalysisJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return job.model_copy(deep=True) if job else None

    def transcript(self, asset_id: str) -> Transcript | None:
        return self.library.load_transcript(asset_id)

    def segments(self, asset_id: str) -> list[MediaSegment]:
        return self.library.load_segments(asset_id)

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
                transcript = self.library.load_transcript(asset.asset_id)
                if transcript is None:
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
                self._add_capability(job_id, AnalysisCapability.TRANSCRIPT)

                describer = self._describer()
                self._update_job(job_id, AnalysisStage.BUILDING_TIMELINE, 70, "正在构建时间轴事件")
                markers = self._job_markers(job)
                asset_directory = self.library.asset_directory(asset.asset_id)
                segments = await asyncio.to_thread(
                    build_segments,
                    transcript,
                    playback,
                    asset.asset_id,
                    asset_directory,
                    asset.duration_seconds,
                    self.settings,
                    describer,
                    job.mode,
                    markers,
                    lambda stage, progress, message: self._update_job(
                        job_id,
                        stage,
                        progress,
                        message,
                    ),
                )
                self._add_capability(job_id, AnalysisCapability.TIMELINE)
                if describer is not None and any(segment.visual_description for segment in segments):
                    self._add_capability(job_id, AnalysisCapability.VISUAL)
                completed_stage = (
                    AnalysisStage.DESCRIBING_VISUALS
                    if describer is not None
                    else AnalysisStage.EXTRACTING_FRAMES
                )
                self._update_job(
                    job_id,
                    completed_stage,
                    95,
                    f"已生成 {len(segments)} 个时间轴事件",
                )
                merged_segments = self._merge_segments(job, segments)
                self.library.save_segments(asset.asset_id, merged_segments)
                message = (
                    "分析完成"
                    if describer is not None
                    else "音频时间轴分析完成（未配置视觉模型）"
                )
                self._update_job(job_id, AnalysisStage.COMPLETE, 100, message)
            except Exception as error:
                self._fail(job_id, str(error) or "分析失败")
            finally:
                with self._lock:
                    self._active_job_id_by_asset_id.pop(job.asset_id, None)

    def _describer(self) -> OpenAiCompatibleVision | None:
        if not self.settings.openai_api_key:
            return None
        return OpenAiCompatibleVision(
            base_url=self.settings.openai_base_url,
            api_key=self.settings.openai_api_key,
            model=self.settings.vision_model,
        )

    def _transcriber(self) -> FasterWhisperTranscriber:
        return FasterWhisperTranscriber(
            model_size=self.settings.whisper_model,
            language=self.settings.whisper_language,
            compute_type=self.settings.whisper_compute_type,
        )

    def _validated_marker_ids(
        self,
        asset_id: str,
        mode: AnalysisMode,
        marker_ids: list[str],
    ) -> list[str]:
        if mode == AnalysisMode.FULL:
            return []
        markers = self.library.load_markers(asset_id)
        available_ids = {marker.marker_id for marker in markers}
        resolved_ids = (
            list(dict.fromkeys(marker_ids))
            if marker_ids
            else [marker.marker_id for marker in markers]
        )
        if not resolved_ids:
            raise AnalysisError("请先添加至少一个标记")
        if any(marker_id not in available_ids for marker_id in resolved_ids):
            raise AnalysisError("分析请求包含不存在的标记")
        return resolved_ids

    def _job_markers(self, job: AnalysisJob) -> list[MediaMarker]:
        if job.mode == AnalysisMode.FULL:
            return []
        selected_ids = set(job.marker_ids)
        return [
            marker
            for marker in self.library.load_markers(job.asset_id)
            if marker.marker_id in selected_ids
        ]

    def _merge_segments(
        self,
        job: AnalysisJob,
        new_segments: list[MediaSegment],
    ) -> list[MediaSegment]:
        existing = self.library.load_segments(job.asset_id)
        if job.mode == AnalysisMode.FULL:
            retained = [segment for segment in existing if segment.marker_ids]
        else:
            selected_ids = set(job.marker_ids)
            retained = [
                segment
                for segment in existing
                if not selected_ids.intersection(segment.marker_ids)
            ]
        return sorted([*retained, *new_segments], key=lambda segment: segment.start_seconds)

    def _add_capability(self, job_id: str, capability: AnalysisCapability) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job and capability not in job.capabilities:
                job.capabilities.append(capability)
                self.library.save_analysis_job(job)

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
            self.library.save_analysis_job(job)

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
    def _completed_job(
        asset_id: str,
        mode: AnalysisMode,
        marker_ids: list[str],
    ) -> AnalysisJob:
        return AnalysisJob(
            job_id=f"analysis-{uuid7().hex}",
            asset_id=asset_id,
            mode=mode,
            marker_ids=marker_ids,
            capabilities=[AnalysisCapability.TRANSCRIPT, AnalysisCapability.TIMELINE],
            stage=AnalysisStage.COMPLETE,
            progress_percent=100,
            message="该视频已有时间轴分析结果",
        )
