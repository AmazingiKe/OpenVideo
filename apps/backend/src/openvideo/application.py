import asyncio
from datetime import UTC, datetime
from threading import RLock

from openvideo.core.ai_models import IMAGE_INPUT_MODALITY
from openvideo.core.analysis_models import (
    AnalysisCapability,
    AnalysisJob,
    AnalysisMode,
    AnalysisOperation,
    AnalysisStage,
    AnalysisStrategy,
    TERMINAL_ANALYSIS_STAGES,
    Transcript,
    TranscriptionMetadata,
    TranscriptionOptions,
    TranscriptionStatus,
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
from openvideo.transcription_model_manager import (
    TranscriptionModelDownloadError,
    require_transcription_model_installed,
)
from openvideo.download_accounts import (
    DownloadAccountExpired,
    DownloadAccountStore,
)
from openvideo.tools.analysis_pipeline import build_segments
from openvideo.tools.downloader import (
    DownloadFailure,
    download_video,
    is_authentication_failure,
)
from openvideo.tools.media import probe_media
from openvideo.tools.sources import SourceMatch
from openvideo.tools.thumbnails import generate_thumbnail_sprite
from openvideo.tools.transcribe import (
    Transcriber,
    TranscriptionFailure,
    create_transcriber,
    require_transcription_adapter,
    transcribe_media,
)
from openvideo.tools.vision import LiteLlmVision


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

        asset_id = str(uuid7())
        job_id = f"job-{uuid7().hex}"
        asset = MediaAsset(
            asset_id=asset_id,
            source_url=source.normalized_url,
            source_platform=source.platform,
            source_video_id=source.source_video_id,
        )
        job = DownloadJob(job_id=job_id, asset_id=asset_id)
        self.library.save(asset)
        self.library.save_download_job(job)
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

    def has_active_jobs(self) -> bool:
        with self._lock:
            return any(job.stage not in TERMINAL_DOWNLOAD_STAGES for job in self._jobs.values())

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
                        cookie_source=cookie_source,
                        staging_directory=self.library.temporary_directory(job_id),
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
                storyboard = await asyncio.to_thread(
                    generate_thumbnail_sprite,
                    downloaded.playback_file,
                    self.library.media_directory(asset.asset_id),
                    asset.duration_seconds,
                    self.settings.ffmpeg_path,
                    self.settings.ffmpeg_bin_dir,
                )
                if storyboard:
                    asset.thumbnail_sprite_path = (
                        self.library.media_directory(asset.asset_id) / storyboard.sprite_path
                    ).relative_to(self.library.asset_directory(asset.asset_id)).as_posix()
                    asset.thumbnail_tile_width = storyboard.tile_width
                    asset.thumbnail_tile_height = storyboard.tile_height
                    asset.thumbnail_interval_seconds = storyboard.interval_seconds
                    asset.thumbnail_columns = storyboard.columns
                    asset.thumbnail_total_tiles = storyboard.total_tiles
                asset.status = MediaAssetStatus.READY
                asset.error_message = None
                self.library.save(asset)
                self._update_job(job_id, DownloadStage.COMPLETE, 100, "下载完成")
            except DownloadAccountExpired as error:
                self._fail(job_id, str(error))
            except Exception as error:
                if is_authentication_failure(error):
                    self.download_account_store.mark_expired(asset.source_platform)
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


class AnalysisPrerequisiteError(AnalysisError):
    """分析缺少用户可补充的前置产物时抛出，以区别资源不存在。"""


class AnalysisManager:
    """分析任务把转写等长耗时计算与短生命周期 HTTP 请求隔离开。"""

    def __init__(self, library: MediaLibrary, settings: Settings) -> None:
        self.library = library
        self.settings = settings
        self._jobs: dict[str, AnalysisJob] = {}
        self._active_job_id_by_asset_id: dict[str, str] = {}
        self._transcription_options_by_job_id: dict[str, TranscriptionOptions] = {}
        self._lock = RLock()
        self._analysis_lock = asyncio.Lock()

    def create_analysis(
        self,
        asset_id: str,
        mode: AnalysisMode,
        marker_ids: list[str],
        ai_model_id: str | None,
        strategy: AnalysisStrategy,
        force: bool,
    ) -> AnalysisJob:
        asset = self.library.get(asset_id)
        if not asset or asset.status != MediaAssetStatus.READY:
            raise AnalysisError("视频尚未就绪，无法分析")
        if self.library.load_transcript(asset_id) is None:
            raise AnalysisPrerequisiteError("请先完成视频转录，再开始内容分析")
        if ai_model_id:
            model = self.settings.ai_model(ai_model_id)
            if model is None:
                raise AnalysisPrerequisiteError("所选 AI 模型不存在，请在设置中重新选择")
            if IMAGE_INPUT_MODALITY not in model.input_modalities:
                raise AnalysisPrerequisiteError("所选 AI 模型不支持视觉分析")
        active_job = self._active_job_for(asset_id)
        if active_job:
            return active_job
        resolved_marker_ids = self._validated_marker_ids(asset_id, mode, marker_ids)
        existing_segments = self.library.load_segments(asset_id)
        has_full_timeline = any(not segment.marker_ids for segment in existing_segments)
        if mode == AnalysisMode.FULL and has_full_timeline and not force:
            return self._completed_job(asset_id, mode, [])

        job_id = f"job-{uuid7().hex}"
        job = AnalysisJob(
            job_id=job_id,
            asset_id=asset_id,
            mode=mode,
            marker_ids=resolved_marker_ids,
            ai_model_id=ai_model_id,
            strategy=strategy,
        )
        with self._lock:
            self._jobs[job_id] = job
            self._active_job_id_by_asset_id[asset_id] = job_id
        self.library.save_analysis_job(job)
        return job.model_copy(deep=True)

    def create_transcription(
        self,
        asset_id: str,
        options: TranscriptionOptions,
        force: bool,
    ) -> AnalysisJob:
        asset = self.library.get(asset_id)
        if not asset or asset.status != MediaAssetStatus.READY:
            raise AnalysisError("视频尚未就绪，无法转录")
        try:
            descriptor = require_transcription_adapter(options)
            require_transcription_model_installed(
                descriptor,
                self.settings.models_root_directory,
            )
        except (TranscriptionFailure, TranscriptionModelDownloadError) as error:
            raise AnalysisPrerequisiteError(str(error)) from error
        active_job = self._active_job_for(asset_id)
        if active_job:
            return active_job
        existing_transcript = self.library.load_transcript(asset_id)
        if existing_transcript is not None and not force:
            return AnalysisJob(
                job_id=f"job-{uuid7().hex}",
                asset_id=asset_id,
                operation=AnalysisOperation.TRANSCRIPTION,
                capabilities=[AnalysisCapability.TRANSCRIPT],
                stage=AnalysisStage.COMPLETE,
                progress_percent=100,
                message="该视频已有转录结果",
            )
        job = AnalysisJob(
            job_id=f"job-{uuid7().hex}",
            asset_id=asset_id,
            operation=AnalysisOperation.TRANSCRIPTION,
        )
        with self._lock:
            self._jobs[job.job_id] = job
            self._active_job_id_by_asset_id[asset_id] = job.job_id
            self._transcription_options_by_job_id[job.job_id] = options
        self.library.save_analysis_job(job)
        self.library.save_transcription_metadata(
            TranscriptionMetadata(
                job_id=job.job_id,
                asset_id=asset_id,
                status=TranscriptionStatus.PENDING,
                attempt_count=self._next_transcription_attempt_count(
                    asset_id,
                    existing_transcript is not None,
                ),
                engine=options.engine,
                options=options,
            )
        )
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
            if job.operation == AnalysisOperation.TRANSCRIPTION:
                metadata = self.library.load_transcription_metadata(job.asset_id)
                if metadata and metadata.job_id == job.job_id:
                    self._transcription_options_by_job_id[job.job_id] = metadata.options
            if job.stage == AnalysisStage.PENDING:
                self.start(job.job_id)

    def get(self, job_id: str) -> AnalysisJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return job.model_copy(deep=True) if job else None

    def has_active_jobs(self) -> bool:
        with self._lock:
            return any(job.stage not in TERMINAL_ANALYSIS_STAGES for job in self._jobs.values())

    def transcript(self, asset_id: str) -> Transcript | None:
        return self.library.load_transcript(asset_id)

    def update_transcript_segment(
        self,
        asset_id: str,
        segment_index: int,
        text: str,
    ) -> Transcript:
        transcript = self.library.load_transcript(asset_id)
        if transcript is None:
            raise AnalysisError("该视频还没有转写结果")
        if segment_index < 0 or segment_index >= len(transcript.segments):
            raise AnalysisError("转写片段不存在")
        updated_segments = list(transcript.segments)
        updated_segments[segment_index] = updated_segments[segment_index].model_copy(
            update={"text": text}
        )
        updated_transcript = transcript.model_copy(update={"segments": updated_segments})
        self.library.save_transcript(updated_transcript)
        return updated_transcript

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
            transcription_started_at: datetime | None = None
            transcription_options = self._transcription_options_by_job_id.get(
                job_id,
                self.settings.default_transcription,
            )
            saved_metadata = self.library.load_transcription_metadata(asset.asset_id)
            attempt_count = (
                saved_metadata.attempt_count
                if saved_metadata and saved_metadata.job_id == job_id
                else 1
            )
            try:
                playback = self.library.resolve_asset_file(asset, asset.playback_path)
                if not playback:
                    raise AnalysisError("视频文件不存在")
                transcript = self.library.load_transcript(asset.asset_id)
                should_transcribe = (
                    transcript is None
                    or job.operation == AnalysisOperation.TRANSCRIPTION
                )
                if should_transcribe:
                    saved_metadata = self.library.load_transcription_metadata(
                        asset.asset_id
                    )
                    attempt_count = (
                        saved_metadata.attempt_count
                        if saved_metadata and saved_metadata.job_id == job_id
                        else self._next_transcription_attempt_count(
                            asset.asset_id,
                            transcript is not None,
                        )
                    )
                    transcription_started_at = datetime.now(UTC)
                    self.library.save_transcription_metadata(
                        TranscriptionMetadata(
                            job_id=job_id,
                            asset_id=asset.asset_id,
                            status=TranscriptionStatus.RUNNING,
                            attempt_count=attempt_count,
                            engine=transcription_options.engine,
                            options=transcription_options,
                            started_at=transcription_started_at,
                        )
                    )
                    self._update_job(job_id, AnalysisStage.EXTRACTING_AUDIO, 5, "正在提取音频")
                    work_directory = self.library.temporary_directory(job_id)
                    transcription_result = await asyncio.to_thread(
                        transcribe_media,
                        playback,
                        asset.asset_id,
                        asset.source_url,
                        work_directory,
                        self.settings.ffmpeg_path,
                        self.settings.ffmpeg_bin_dir,
                        self._transcriber(transcription_options),
                    )
                    transcript = transcription_result.transcript
                    self._update_job(
                        job_id,
                        AnalysisStage.TRANSCRIBING,
                        60,
                        "正在将音频转写为文字",
                    )
                    self.library.save_transcript(transcript)
                    completed_at = datetime.now(UTC)
                    self.library.save_transcription_metadata(
                        TranscriptionMetadata(
                            job_id=job_id,
                            asset_id=asset.asset_id,
                            status=TranscriptionStatus.COMPLETE,
                            attempt_count=attempt_count,
                            engine=transcription_options.engine,
                            output_source=transcription_result.output_source,
                            options=transcription_options,
                            started_at=transcription_started_at,
                            completed_at=completed_at,
                            duration_seconds=(completed_at - transcription_started_at).total_seconds(),
                        )
                    )
                self._add_capability(job_id, AnalysisCapability.TRANSCRIPT)

                if job.operation == AnalysisOperation.TRANSCRIPTION:
                    self._update_job(job_id, AnalysisStage.COMPLETE, 100, "转录完成")
                    return

                describer = self._describer(job.ai_model_id)
                self._update_job(job_id, AnalysisStage.BUILDING_TIMELINE, 70, "正在构建时间轴事件")
                markers = self._job_markers(job)
                asset_directory = self.library.artifacts_directory(asset.asset_id)
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
                    job.strategy,
                    lambda stage, progress, message: self._update_job(
                        job_id,
                        stage,
                        progress,
                        message,
                    ),
                )
                for segment in segments:
                    segment.key_frame_paths = [
                        f"artifacts/{relative_path}"
                        for relative_path in segment.key_frame_paths
                    ]
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
                if job.operation == AnalysisOperation.TRANSCRIPTION:
                    failed_at = datetime.now(UTC)
                    self.library.save_transcription_metadata(
                        TranscriptionMetadata(
                            job_id=job_id,
                            asset_id=asset.asset_id,
                            status=TranscriptionStatus.FAILED,
                            attempt_count=attempt_count,
                            engine=transcription_options.engine,
                            options=transcription_options,
                            started_at=transcription_started_at,
                            completed_at=failed_at,
                            duration_seconds=(
                                (failed_at - transcription_started_at).total_seconds()
                                if transcription_started_at
                                else 0
                            ),
                            error_message=str(error) or "转录失败",
                        )
                    )
                self._fail(job_id, str(error) or "分析失败")
            finally:
                with self._lock:
                    self._active_job_id_by_asset_id.pop(job.asset_id, None)

    def _describer(self, ai_model_id: str | None) -> LiteLlmVision | None:
        if ai_model_id is None:
            return None
        model = self.settings.ai_model(ai_model_id)
        if model is None:
            raise AnalysisPrerequisiteError("分析任务使用的 AI 模型已被删除")
        return LiteLlmVision(model)

    def _transcriber(self, options: TranscriptionOptions) -> Transcriber:
        return create_transcriber(options, self.settings.models_root_directory)

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
            return self.library.load_markers(job.asset_id)
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
        failure_message = (
            "转录失败"
            if job.operation == AnalysisOperation.TRANSCRIPTION
            else "分析失败"
        )
        self._update_job(
            job_id,
            AnalysisStage.FAILED,
            job.progress_percent,
            failure_message,
            message,
        )

    def _active_job_for(self, asset_id: str) -> AnalysisJob | None:
        with self._lock:
            job_id = self._active_job_id_by_asset_id.get(asset_id)
            job = self._jobs.get(job_id) if job_id else None
            return job.model_copy(deep=True) if job else None

    def _next_transcription_attempt_count(
        self,
        asset_id: str,
        has_transcript: bool,
    ) -> int:
        metadata = self.library.load_transcription_metadata(asset_id)
        if metadata is not None:
            return metadata.attempt_count + 1
        return 2 if has_transcript else 1

    @staticmethod
    def _completed_job(
        asset_id: str,
        mode: AnalysisMode,
        marker_ids: list[str],
    ) -> AnalysisJob:
        return AnalysisJob(
            job_id=f"job-{uuid7().hex}",
            asset_id=asset_id,
            mode=mode,
            marker_ids=marker_ids,
            strategy=AnalysisStrategy(),
            capabilities=[AnalysisCapability.TRANSCRIPT, AnalysisCapability.TIMELINE],
            stage=AnalysisStage.COMPLETE,
            progress_percent=100,
            message="该视频已有时间轴分析结果",
        )
