import asyncio
from collections.abc import Callable
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock

from openvideo.core.ai_models import IMAGE_INPUT_MODALITY
from openvideo.core.analysis_models import (
    AnalysisCapability,
    AnalysisDepth,
    AnalysisJob,
    AnalysisMode,
    AnalysisOperation,
    AnalysisStage,
    AnalysisStrategy,
    INACTIVE_ANALYSIS_STAGES,
    TERMINAL_ANALYSIS_STAGES,
)
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import MediaAssetStatus, MediaSegment
from openvideo.core.transcription_models import (
    Transcript,
    TranscriptionMetadata,
    TranscriptionModelDescriptor,
    TranscriptionOptions,
    TranscriptionStatus,
)
from openvideo.settings import Settings
from openvideo.transcription_model_manager import (
    TranscriptionModelDownloadError,
    download_transcription_model,
    is_transcription_model_installed,
    require_transcription_model_installed,
)
from openvideo.tools.analysis_pipeline import OcrReader, build_segments
from openvideo.tools.ocr import LocalOcrReader
from openvideo.tools.transcribe import (
    Transcriber,
    TranscriptionFailure,
    TranscriptionProgress,
    create_transcriber,
    require_transcription_adapter,
    transcribe_media,
)
from openvideo.tools.vision import LiteLlmVision


TranscriptionModelInstaller = Callable[
    [TranscriptionModelDescriptor, Path, Callable[[int, int], None]],
    None,
]
TRANSCRIPTION_PROGRESS_START_PERCENT = 10
TRANSCRIPTION_PROGRESS_END_PERCENT = 65
TRANSCRIPTION_SAVE_PROGRESS_PERCENT = 66
TRANSCRIPTION_LATEST_TEXT_MAX_CHARACTERS = 56
SECONDS_PER_MINUTE = 60


def _segments_overlap(first: MediaSegment, second: MediaSegment) -> bool:
    return (
        first.start_seconds < second.end_seconds
        and second.start_seconds < first.end_seconds
    )


def _segment_digest(segments: list[MediaSegment]) -> str:
    payload = [segment.model_dump(mode="json") for segment in segments]
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()


def _transcription_duration_label(seconds: float) -> str:
    whole_seconds = max(round(seconds), 0)
    minutes, remaining_seconds = divmod(whole_seconds, SECONDS_PER_MINUTE)
    return f"{minutes:02d}:{remaining_seconds:02d}"


class AnalysisError(RuntimeError):
    """分析任务无法创建或执行时抛出。"""


class AnalysisPrerequisiteError(AnalysisError):
    """分析缺少用户可补充的前置产物时抛出，以区别资源不存在。"""


class AnalysisManager:
    """分析任务把转写等长耗时计算与短生命周期 HTTP 请求隔离开。"""

    def __init__(
        self,
        library: MediaLibrary,
        settings: Settings,
        *,
        model_installer: TranscriptionModelInstaller | None = None,
        ocr_reader: OcrReader | None = None,
        on_evidence_ready: Callable[[], None] | None = None,
    ) -> None:
        self.library = library
        self.settings = settings
        self._jobs: dict[str, AnalysisJob] = {}
        self._active_job_id_by_asset_id: dict[str, str] = {}
        self._transcription_options_by_job_id: dict[str, TranscriptionOptions] = {}
        self._lock = RLock()
        self._analysis_lock = asyncio.Lock()
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._model_installer = model_installer or download_transcription_model
        self._ocr_reader = ocr_reader or LocalOcrReader().read_frames
        self._on_evidence_ready = on_evidence_ready or (lambda: None)

    def create_analysis(
        self,
        asset_id: str,
        mode: AnalysisMode,
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
                raise AnalysisPrerequisiteError(
                    "所选 AI 模型不存在，请在设置中重新选择"
                )
            if IMAGE_INPUT_MODALITY not in model.input_modalities:
                raise AnalysisPrerequisiteError("所选 AI 模型不支持视觉分析")
        active_job = self._active_job_for(asset_id)
        if active_job:
            return active_job
        existing_segments = self.library.load_segments(asset_id)
        has_full_timeline = any(not segment.marker_ids for segment in existing_segments)
        if mode == AnalysisMode.FULL and has_full_timeline and not force:
            return self._completed_job(asset_id, mode)

        job_id = f"job-{uuid7().hex}"
        job = AnalysisJob(
            job_id=job_id,
            asset_id=asset_id,
            mode=mode,
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

    def create_initialization(self, asset_id: str) -> AnalysisJob:
        """为就绪素材创建无需用户决策的本地渐进分析任务。"""

        asset = self.library.get(asset_id)
        if not asset or asset.status != MediaAssetStatus.READY:
            raise AnalysisError("视频尚未就绪，无法初始化")
        active_job = self._active_job_for(asset_id)
        if active_job:
            return active_job
        transcript = self.library.load_transcript(asset_id)
        segments = self.library.load_segments(asset_id)
        capabilities = self._existing_capabilities(transcript, segments)
        if (
            transcript is not None
            and segments
            and AnalysisCapability.KEY_FRAMES in capabilities
        ):
            return AnalysisJob(
                job_id=f"job-{uuid7().hex}",
                asset_id=asset_id,
                operation=AnalysisOperation.INITIALIZATION,
                capabilities=capabilities,
                stage=AnalysisStage.COMPLETE,
                progress_percent=100,
                message="该视频的本地分析产物已就绪",
            )
        job = AnalysisJob(
            job_id=f"job-{uuid7().hex}",
            asset_id=asset_id,
            operation=AnalysisOperation.INITIALIZATION,
            strategy=AnalysisStrategy(depth=AnalysisDepth.DEEP),
            capabilities=capabilities,
            message="等待后台初始化",
        )
        with self._lock:
            self._jobs[job.job_id] = job
            self._active_job_id_by_asset_id[asset_id] = job.job_id
            self._transcription_options_by_job_id[job.job_id] = (
                self.settings.default_transcription
            )
        self.library.save_analysis_job(job)
        if transcript is None:
            self.library.save_transcription_metadata(
                TranscriptionMetadata(
                    job_id=job.job_id,
                    asset_id=asset_id,
                    status=TranscriptionStatus.PENDING,
                    attempt_count=self._next_transcription_attempt_count(
                        asset_id,
                        False,
                    ),
                    engine=self.settings.default_transcription.engine,
                    options=self.settings.default_transcription,
                )
            )
        return job.model_copy(deep=True)

    def initialize_asset(self, asset_id: str) -> AnalysisJob:
        job = self.create_initialization(asset_id)
        if job.stage not in TERMINAL_ANALYSIS_STAGES:
            self.start(job.job_id)
        return job

    def initialize_ready_assets(self) -> None:
        for asset in self.library.list():
            if asset.status == MediaAssetStatus.READY:
                self.initialize_asset(asset.asset_id)

    def start(self, job_id: str) -> None:
        with self._lock:
            current = self._tasks.get(job_id)
            if current and not current.done():
                return
            task = asyncio.create_task(self._run(job_id))
            self._tasks[job_id] = task
            task.add_done_callback(lambda _: self._discard_task(job_id))

    def restore(self) -> None:
        """服务重启后恢复未完成任务，复用已经落盘的转写与事件产物。"""
        for saved_job in self.library.load_analysis_jobs():
            job = saved_job.model_copy(deep=True)
            if job.stage not in INACTIVE_ANALYSIS_STAGES:
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

    async def close(self) -> None:
        if self._tasks:
            await asyncio.gather(*self._tasks.values(), return_exceptions=True)

    def get(self, job_id: str) -> AnalysisJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return job.model_copy(deep=True) if job else None

    def has_active_jobs(self) -> bool:
        with self._lock:
            return any(
                job.stage not in INACTIVE_ANALYSIS_STAGES for job in self._jobs.values()
            )

    async def cancel_assets(self, asset_ids: set[str]) -> bool:
        with self._lock:
            jobs = [
                job.model_copy(deep=True)
                for job in self._jobs.values()
                if job.asset_id in asset_ids
                and job.stage not in INACTIVE_ANALYSIS_STAGES
            ]
            tasks = [
                self._tasks[job.job_id] for job in jobs if job.job_id in self._tasks
            ]
        if any(job.stage != AnalysisStage.PENDING for job in jobs):
            # 转录与画面分析运行在线程中，底层工具返回前删除目录会产生写回竞争。
            return False
        for job in jobs:
            self._fail(job.job_id, "素材已请求删除，分析任务已取消")
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        return all(task.done() for task in tasks)

    def _discard_task(self, job_id: str) -> None:
        with self._lock:
            self._tasks.pop(job_id, None)

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
        updated_transcript = transcript.model_copy(
            update={"segments": updated_segments}
        )
        self.library.save_transcript(updated_transcript)
        self._on_evidence_ready()
        return updated_transcript

    def segments(self, asset_id: str) -> list[MediaSegment]:
        return self.library.load_segments(asset_id)

    def approve_proposal(self, job_id: str) -> AnalysisJob:
        job = self.get(job_id)
        if job is None:
            raise AnalysisError("分析任务不存在")
        if job.stage != AnalysisStage.WAITING_FOR_APPROVAL:
            raise AnalysisError("分析任务当前没有待确认结果")
        current = self.library.load_segments(job.asset_id)
        if _segment_digest(current) != job.proposal_base_digest:
            raise AnalysisError("时间轴已发生变化，请重新运行分析")
        self.library.save_segments(job.asset_id, job.proposed_segments)
        self._on_evidence_ready()
        self._finish_analysis_proposal(job_id, AnalysisStage.COMPLETE, "分析结果已确认")
        return self.get(job_id) or job

    def reject_proposal(self, job_id: str) -> AnalysisJob:
        job = self.get(job_id)
        if job is None:
            raise AnalysisError("分析任务不存在")
        if job.stage != AnalysisStage.WAITING_FOR_APPROVAL:
            raise AnalysisError("分析任务当前没有待确认结果")
        self._finish_analysis_proposal(job_id, AnalysisStage.REJECTED, "已放弃分析预览")
        return self.get(job_id) or job

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
            transcription_completed = False
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
            should_transcribe = False
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
                    if job.operation == AnalysisOperation.INITIALIZATION:
                        descriptor = require_transcription_adapter(
                            transcription_options
                        )
                        if not is_transcription_model_installed(
                            descriptor,
                            self.settings.models_root_directory,
                        ):
                            self._update_job(
                                job_id,
                                AnalysisStage.PREPARING_TRANSCRIPTION_MODEL,
                                1,
                                f"正在准备本地转录模型：{descriptor.name}",
                            )
                            await asyncio.to_thread(
                                self._model_installer,
                                descriptor,
                                self.settings.models_root_directory,
                                lambda downloaded, total: self._report_model_progress(
                                    job_id,
                                    descriptor.name,
                                    downloaded,
                                    total,
                                ),
                            )
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
                    self._update_job(
                        job_id, AnalysisStage.EXTRACTING_AUDIO, 5, "正在提取音频"
                    )
                    work_directory = self.library.temporary_directory(job_id)
                    transcription_result = await asyncio.to_thread(
                        transcribe_media,
                        playback,
                        asset.asset_id,
                        asset.source_url,
                        work_directory,
                        self.settings.ffmpeg_path,
                        self.settings.ffmpeg_bin_dir,
                        self._transcriber(
                            transcription_options,
                            lambda progress: self._report_transcription_progress(
                                job_id,
                                progress,
                            ),
                        ),
                    )
                    transcript = transcription_result.transcript
                    self._update_job(
                        job_id,
                        AnalysisStage.TRANSCRIBING,
                        TRANSCRIPTION_SAVE_PROGRESS_PERCENT,
                        "正在保存完整转录",
                    )
                    self.library.save_transcript(transcript)
                    self._on_evidence_ready()
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
                            duration_seconds=(
                                completed_at - transcription_started_at
                            ).total_seconds(),
                        )
                    )
                    transcription_completed = True
                self._add_capability(job_id, AnalysisCapability.TRANSCRIPT)

                if job.operation == AnalysisOperation.TRANSCRIPTION:
                    self._update_job(job_id, AnalysisStage.COMPLETE, 100, "转录完成")
                    return

                describer = (
                    None
                    if job.operation == AnalysisOperation.INITIALIZATION
                    else self._describer(job.ai_model_id)
                )
                self._update_job(
                    job_id, AnalysisStage.BUILDING_TIMELINE, 70, "正在构建时间轴事件"
                )
                markers = self.library.load_markers(job.asset_id)
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
                    markers,
                    job.strategy,
                    lambda stage, progress, message: self._update_job(
                        job_id,
                        stage,
                        progress,
                        message,
                    ),
                    (
                        self.settings.ai_model(job.ai_model_id)
                        if job.ai_model_id
                        and job.operation != AnalysisOperation.INITIALIZATION
                        else None
                    ),
                    self._ocr_reader,
                )
                for segment in segments:
                    segment.key_frame_paths = [
                        f"artifacts/{relative_path}"
                        for relative_path in segment.key_frame_paths
                    ]
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
                proposed_segments = self._validate_and_sort_segments(job, segments)
                if not proposed_segments:
                    raise AnalysisError(
                        "未能生成时间轴事件，请检查视频时长和本地媒体文件"
                    )
                self._add_capability(job_id, AnalysisCapability.TIMELINE)
                self._add_capability(job_id, AnalysisCapability.CHAPTERS)
                has_key_frames = any(
                    segment.key_frame_paths for segment in proposed_segments
                )
                if has_key_frames:
                    self._add_capability(job_id, AnalysisCapability.KEY_FRAMES)
                has_ocr_text = any(segment.ocr_text for segment in proposed_segments)
                if has_ocr_text:
                    self._add_capability(job_id, AnalysisCapability.OCR)
                if describer is not None and any(
                    segment.visual_description for segment in proposed_segments
                ):
                    self._add_capability(job_id, AnalysisCapability.VISUAL)
                if job.operation == AnalysisOperation.INITIALIZATION:
                    self.library.save_segments(job.asset_id, proposed_segments)
                    self._on_evidence_ready()
                    if not has_key_frames:
                        raise AnalysisError(
                            "本地时间轴已保存，但未能提取关键帧，请检查 FFmpeg 与媒体文件"
                        )
                    self._update_job(
                        job_id,
                        AnalysisStage.QUEUING_INDEX,
                        99,
                        "本地证据已生成，正在更新检索索引",
                    )
                    self._update_job(
                        job_id,
                        AnalysisStage.COMPLETE,
                        100,
                        (
                            "转录、章节、关键帧与画面文字已完成"
                            if has_ocr_text
                            else "转录、章节与关键帧已完成，画面未检测到可识别文字"
                        ),
                    )
                    return
                message = (
                    "分析预览已生成，等待确认"
                    if describer is not None
                    else "音频时间轴预览已生成，等待确认（未配置视觉模型）"
                )
                self._set_analysis_proposal(
                    job_id,
                    _segment_digest(self.library.load_segments(asset.asset_id)),
                    proposed_segments,
                    message,
                )
            except Exception as error:
                if (
                    job.operation
                    in {
                        AnalysisOperation.TRANSCRIPTION,
                        AnalysisOperation.INITIALIZATION,
                    }
                    and should_transcribe
                    and not transcription_completed
                ):
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

    def _transcriber(
        self,
        options: TranscriptionOptions,
        progress_reporter: Callable[[TranscriptionProgress], None],
    ) -> Transcriber:
        return create_transcriber(
            options,
            self.settings.models_root_directory,
            progress_reporter=progress_reporter,
        )

    def _validate_and_sort_segments(
        self,
        job: AnalysisJob,
        new_segments: list[MediaSegment],
    ) -> list[MediaSegment]:
        sorted_segments = sorted(
            new_segments,
            key=lambda segment: segment.start_seconds,
        )
        marker_ids = {
            marker.marker_id for marker in self.library.load_markers(job.asset_id)
        }
        if any(
            marker_id not in marker_ids
            for segment in sorted_segments
            for marker_id in segment.marker_ids
        ):
            raise AnalysisError("分析结果引用了不存在的人工标记")
        if len({segment.segment_id for segment in sorted_segments}) != len(
            sorted_segments
        ):
            raise AnalysisError("分析结果包含重复事件")
        if any(
            _segments_overlap(previous, current)
            for previous, current in zip(
                sorted_segments,
                sorted_segments[1:],
                strict=False,
            )
        ):
            raise AnalysisError("分析结果包含重叠事件")
        return sorted_segments

    def _add_capability(self, job_id: str, capability: AnalysisCapability) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job and capability not in job.capabilities:
                job.capabilities.append(capability)
                self.library.save_analysis_job(job)

    def _set_analysis_proposal(
        self,
        job_id: str,
        base_digest: str,
        proposed_segments: list[MediaSegment],
        message: str,
    ) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or job.stage in TERMINAL_ANALYSIS_STAGES:
                return
            job.stage = AnalysisStage.WAITING_FOR_APPROVAL
            job.progress_percent = 100
            job.message = message
            job.proposal_base_digest = base_digest
            job.proposed_segments = [
                segment.model_copy(deep=True) for segment in proposed_segments
            ]
            job.updated_at = datetime.now(UTC)
            self.library.save_analysis_job(job)

    def _finish_analysis_proposal(
        self, job_id: str, stage: AnalysisStage, message: str
    ) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or job.stage != AnalysisStage.WAITING_FOR_APPROVAL:
                return
            job.stage = stage
            job.progress_percent = 100
            job.message = message
            job.proposal_base_digest = None
            job.proposed_segments = []
            job.updated_at = datetime.now(UTC)
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
        failure_message = {
            AnalysisOperation.TRANSCRIPTION: "转录失败",
            AnalysisOperation.ANALYSIS: "分析失败",
            AnalysisOperation.INITIALIZATION: "后台初始化失败",
        }[job.operation]
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

    def _report_model_progress(
        self,
        job_id: str,
        model_name: str,
        downloaded_bytes: int,
        total_bytes: int,
    ) -> None:
        ratio = downloaded_bytes / total_bytes if total_bytes else 0
        self._update_job(
            job_id,
            AnalysisStage.PREPARING_TRANSCRIPTION_MODEL,
            1 + ratio * 3,
            f"正在准备本地转录模型：{model_name}",
        )

    def _report_transcription_progress(
        self,
        job_id: str,
        progress: TranscriptionProgress,
    ) -> None:
        total_seconds = max(progress.total_seconds, 0)
        completed_seconds = min(max(progress.completed_seconds, 0), total_seconds)
        ratio = completed_seconds / total_seconds if total_seconds else 0
        progress_percent = TRANSCRIPTION_PROGRESS_START_PERCENT + ratio * (
            TRANSCRIPTION_PROGRESS_END_PERCENT - TRANSCRIPTION_PROGRESS_START_PERCENT
        )
        total_label = _transcription_duration_label(total_seconds)
        if completed_seconds == 0:
            message = f"正在加载转录模型 · 音频 {total_label}"
        else:
            completed_label = _transcription_duration_label(completed_seconds)
            message = (
                f"已转写 {completed_label} / {total_label} · "
                f"{progress.segment_count} 段"
            )
        latest_text = (progress.latest_text or "").strip()
        if latest_text:
            if len(latest_text) > TRANSCRIPTION_LATEST_TEXT_MAX_CHARACTERS:
                latest_text = (
                    latest_text[:TRANSCRIPTION_LATEST_TEXT_MAX_CHARACTERS] + "…"
                )
            message = f"{message} · 最新：{latest_text}"
        self._update_job(
            job_id,
            AnalysisStage.TRANSCRIBING,
            progress_percent,
            message,
        )

    @staticmethod
    def _existing_capabilities(
        transcript: Transcript | None,
        segments: list[MediaSegment],
    ) -> list[AnalysisCapability]:
        capabilities: list[AnalysisCapability] = []
        if transcript is not None:
            capabilities.append(AnalysisCapability.TRANSCRIPT)
        if segments:
            capabilities.extend(
                [AnalysisCapability.TIMELINE, AnalysisCapability.CHAPTERS]
            )
        if any(segment.key_frame_paths for segment in segments):
            capabilities.append(AnalysisCapability.KEY_FRAMES)
        if any(segment.ocr_text for segment in segments):
            capabilities.append(AnalysisCapability.OCR)
        if any(segment.visual_description for segment in segments):
            capabilities.append(AnalysisCapability.VISUAL)
        return capabilities

    @staticmethod
    def _completed_job(
        asset_id: str,
        mode: AnalysisMode,
    ) -> AnalysisJob:
        return AnalysisJob(
            job_id=f"job-{uuid7().hex}",
            asset_id=asset_id,
            mode=mode,
            strategy=AnalysisStrategy(),
            capabilities=[AnalysisCapability.TRANSCRIPT, AnalysisCapability.TIMELINE],
            stage=AnalysisStage.COMPLETE,
            progress_percent=100,
            message="该视频已有时间轴分析结果",
        )
