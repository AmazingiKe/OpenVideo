import asyncio
import hashlib
import json
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
    INACTIVE_ANALYSIS_STAGES,
    TERMINAL_ANALYSIS_STAGES,
)
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import MediaAssetStatus, MediaSegment
from openvideo.core.transcription_models import (
    Transcript,
    TranscriptionMetadata,
    TranscriptionOptions,
    TranscriptionStatus,
)
from openvideo.settings import Settings
from openvideo.transcription_model_manager import (
    TranscriptionModelDownloadError,
    require_transcription_model_installed,
)
from openvideo.tools.analysis_pipeline import build_segments
from openvideo.tools.transcribe import (
    Transcriber,
    TranscriptionFailure,
    create_transcriber,
    require_transcription_adapter,
    transcribe_media,
)
from openvideo.tools.vision import LiteLlmVision


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
        self._tasks: dict[str, asyncio.Task[None]] = {}

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
                            duration_seconds=(
                                completed_at - transcription_started_at
                            ).total_seconds(),
                        )
                    )
                self._add_capability(job_id, AnalysisCapability.TRANSCRIPT)

                if job.operation == AnalysisOperation.TRANSCRIPTION:
                    self._update_job(job_id, AnalysisStage.COMPLETE, 100, "转录完成")
                    return

                describer = self._describer(job.ai_model_id)
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
                    self.settings.ai_model(job.ai_model_id)
                    if job.ai_model_id
                    else None,
                )
                for segment in segments:
                    segment.key_frame_paths = [
                        f"artifacts/{relative_path}"
                        for relative_path in segment.key_frame_paths
                    ]
                self._add_capability(job_id, AnalysisCapability.TIMELINE)
                if describer is not None and any(
                    segment.visual_description for segment in segments
                ):
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
                proposed_segments = self._validate_and_sort_segments(job, segments)
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
