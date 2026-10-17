import asyncio
from collections.abc import Callable
import hashlib
import json
import platform
from importlib.util import find_spec
import shutil
from datetime import UTC, datetime
from pathlib import Path
from threading import Event, RLock

from openvideo.bailian_credentials import BailianCredentialError, BailianCredentialStore
from openvideo.core.bailian_models import BailianRegion
from openvideo.core.ai_models import IMAGE_INPUT_MODALITY
from openvideo.core.analysis import build_local_chapters
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
from openvideo.core.media_models import MediaAsset, MediaAssetStatus, MediaSegment
from openvideo.core.transcription_models import (
    BAILIAN_PARAFORMER_MODEL,
    Transcript,
    TranscriptionDevice,
    TranscriptionPreflight,
    TranscriptionEngine,
    TranscriptionMetadata,
    TranscriptionOptions,
    TranscriptionStatus,
)
from openvideo.settings import Settings
from openvideo.transcription_model_manager import (
    TranscriptionModelDownloadError,
    require_transcription_model_installed,
)
from openvideo.analysis_worker import (
    AnalysisProcessWorker,
    AnalysisWorker,
    AnalysisWorkerNotStopped,
    CloudTaskSubmitted,
    CloudSubmissionState,
    ModelProgress,
    StageProgress,
    TimelineRequest,
    TranscriptionRequest,
    WorkerProgress,
)
from openvideo.tools.cancellation import AnalysisCancelled, check_analysis_cancellation
from openvideo.tools.transcribe import (
    TranscriptionFailure,
    TranscriptionProgress,
    TranscriptionResult,
    require_transcription_adapter,
)
from openvideo.tools.bailian_asr import BailianAsrError
from openvideo.tools.media import resolve_tool


TRANSCRIPTION_PROGRESS_START_PERCENT = 10
TRANSCRIPTION_PROGRESS_END_PERCENT = 65
TRANSCRIPTION_SAVE_PROGRESS_PERCENT = 66
TRANSCRIPTION_LATEST_TEXT_MAX_CHARACTERS = 56
TRANSCRIPTION_CONTEXT_MAX_CHARACTERS = 400
SECONDS_PER_MINUTE = 60
CLOUD_SUBMISSION_UNCERTAIN_MESSAGE = "云端提交结果未确认，请在转写窗口核实并恢复任务"
WORKER_REAP_ATTEMPTS = 2
WORKER_REAP_RETRY_SECONDS = 0.1


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


def _chapter_source_digest(
    segments: list[MediaSegment], transcript: Transcript | None
) -> str:
    """防止重建期间用户编辑字幕或旧章节，生成结束后覆盖较新的证据。"""
    transcript_json = transcript.model_dump_json() if transcript else ""
    payload = _segment_digest(segments) + transcript_json
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _needs_local_chapter_rebuild(
    transcript: Transcript,
    segments: list[MediaSegment],
) -> bool:
    """旧初始化结果只有一个全长片段时，升级后需自动补建可导航章节。"""

    if len(segments) != 1:
        return False
    segment = segments[0]
    has_generated_analysis = bool(
        segment.visual_description
        or (
            segment.detailed_summary
            and segment.detailed_summary != segment.transcript_text
        )
    )
    if has_generated_analysis:
        return False
    return len(build_local_chapters(transcript.segments)) > 1


def _transcription_duration_label(seconds: float) -> str:
    whole_seconds = max(round(seconds), 0)
    minutes, remaining_seconds = divmod(whole_seconds, SECONDS_PER_MINUTE)
    return f"{minutes:02d}:{remaining_seconds:02d}"


def _bound_transcript_to_media(
    transcript: Transcript,
    duration_seconds: float | None,
) -> Transcript:
    """ASR 时间戳允许轻微越界，但持久化证据必须落在真实媒体范围内。"""

    if duration_seconds is None or duration_seconds <= 0:
        return transcript
    bounded_segments = []
    for segment in transcript.segments:
        if segment.start_seconds >= duration_seconds:
            continue
        end_seconds = min(segment.end_seconds, duration_seconds)
        if end_seconds <= segment.start_seconds:
            continue
        bounded_segments.append(segment.model_copy(update={"end_seconds": end_seconds}))
    return transcript.model_copy(update={"segments": bounded_segments})


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
        worker: AnalysisWorker | None = None,
        on_evidence_ready: Callable[[], None] | None = None,
        bailian_credential_store: BailianCredentialStore | None = None,
    ) -> None:
        self.library = library
        self.settings = settings
        self._bailian_credentials = bailian_credential_store or BailianCredentialStore()
        self._jobs: dict[str, AnalysisJob] = {}
        self._active_job_id_by_asset_id: dict[str, str] = {}
        self._transcription_options_by_job_id: dict[str, TranscriptionOptions] = {}
        self._lock = RLock()
        self._analysis_lock = asyncio.Lock()
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._cancel_events: dict[str, Event] = {}
        self._running_job_ids: set[str] = set()
        self._unreaped_work_directories: dict[str, Path | None] = {}
        self._worker_available = asyncio.Event()
        self._worker_available.set()
        self._worker_reap_lock = asyncio.Lock()
        self._event_loop: asyncio.AbstractEventLoop | None = None
        self._worker = worker or AnalysisProcessWorker()
        self._on_evidence_ready = on_evidence_ready or (lambda: None)
        self._closing = False

    def _check_accepting_jobs(self) -> None:
        """回收进程期间旧资料库仍可访问，但不能再接收新的分析计算。"""
        if self._closing:
            raise AnalysisPrerequisiteError("资料库正在关闭，无法创建或启动分析任务")

    def create_analysis(
        self,
        asset_id: str,
        mode: AnalysisMode,
        ai_model_id: str | None,
        strategy: AnalysisStrategy,
        force: bool,
    ) -> AnalysisJob:
        self._check_accepting_jobs()
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

    def check_transcription(
        self, asset_ids: list[str], options: TranscriptionOptions
    ) -> TranscriptionPreflight:
        """只读取素材、配置和依赖，避免进入队列后才发现本机准备工作未完成。"""
        issues: list[str] = []
        notes: list[str] = []
        try:
            self._check_accepting_jobs()
            self._validate_transcription_options(options)
        except AnalysisPrerequisiteError as error:
            issues.append(str(error))
        if not resolve_tool(
            self.settings.ffmpeg_path, "ffmpeg", self.settings.ffmpeg_bin_dir
        ):
            issues.append("未找到 ffmpeg，请在设置中配置媒体工具路径")
        if options.engine == TranscriptionEngine.BAILIAN:
            notes.append(
                f"当前地域：{self.settings.bailian_asr.region.value}。只检查密钥是否已保存，不验证余额或服务端权限；开始后按音频时长计费。"
            )
        else:
            runtime_modules = {
                TranscriptionEngine.FASTER_WHISPER: "faster_whisper",
                TranscriptionEngine.SENSEVOICE: "funasr",
                TranscriptionEngine.QWEN3_ASR: "qwen_asr",
            }
            if find_spec(runtime_modules[options.engine]) is None:
                issues.append("本地转录运行依赖未安装，请先完成项目依赖安装")
            needs_cuda = (
                options.device == TranscriptionDevice.CUDA
                or options.engine == TranscriptionEngine.QWEN3_ASR
            )
            if needs_cuda and platform.system() == "Darwin":
                issues.append("当前 Mac 不支持 CUDA，请选择 CPU 转录模型或百炼云端模型")
            notes.append("本机检查不加载模型；显存和实际音频解码会在运行时验证。")
        for asset_id in dict.fromkeys(asset_ids):
            asset = self.library.get(asset_id)
            if asset is None or asset.status != MediaAssetStatus.READY:
                issues.append("所选素材尚未就绪，请等待导入或下载完成")
                continue
            title = asset.title or "未命名视频"
            if not self.library.resolve_asset_file(asset, asset.playback_path):
                issues.append(f"{title}：媒体文件不存在，请重新导入")
            if self._active_job_for(asset_id) is not None:
                issues.append(f"{title}：已有分析任务，请等待完成或停止任务")
            metadata = self.library.load_transcription_metadata(asset_id)
            if metadata and metadata.cloud_submission_uncertain:
                issues.append(f"{title}：{CLOUD_SUBMISSION_UNCERTAIN_MESSAGE}")
        return TranscriptionPreflight(
            ready=not issues, issues=list(dict.fromkeys(issues)), notes=notes
        )

    def _validate_transcription_options(self, options: TranscriptionOptions) -> None:
        """预检查与实际提交共用模型、地域和凭据约束，避免两处判断漂移。"""
        try:
            descriptor = require_transcription_adapter(options)
            require_transcription_model_installed(
                descriptor,
                self.settings.models_root_directory,
            )
            if options.engine == TranscriptionEngine.BAILIAN:
                self._require_bailian_credentials(options)
        except (
            TranscriptionFailure,
            TranscriptionModelDownloadError,
            BailianCredentialError,
        ) as error:
            raise AnalysisPrerequisiteError(str(error)) from error

    def create_transcription(
        self,
        asset_id: str,
        options: TranscriptionOptions,
        force: bool,
    ) -> AnalysisJob:
        self._check_accepting_jobs()
        asset = self.library.get(asset_id)
        if not asset or asset.status != MediaAssetStatus.READY:
            raise AnalysisError("视频尚未就绪，无法转录")
        active_job = self._active_job_for(asset_id)
        if active_job:
            if active_job.operation == AnalysisOperation.TRANSCRIPTION:
                return active_job
            operation_label = {
                AnalysisOperation.CHAPTERS: "章节生成",
                AnalysisOperation.ANALYSIS: "内容分析",
                AnalysisOperation.INITIALIZATION: "后台初始化",
            }[active_job.operation]
            raise AnalysisPrerequisiteError(
                f"{operation_label}正在运行，完成后再开始转录"
            )
        self._validate_transcription_options(options)
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
        previous_metadata = self.library.load_transcription_metadata(asset_id)
        if previous_metadata and previous_metadata.cloud_submission_uncertain:
            raise AnalysisPrerequisiteError(CLOUD_SUBMISSION_UNCERTAIN_MESSAGE)
        cloud_task_id = None
        if (
            options.engine == TranscriptionEngine.BAILIAN
            and previous_metadata is not None
            and previous_metadata.status
            in {TranscriptionStatus.FAILED, TranscriptionStatus.CANCELLED}
            and previous_metadata.options == options
            and previous_metadata.cloud_region == self.settings.bailian_asr.region
        ):
            cloud_task_id = previous_metadata.cloud_task_id
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
                cloud_task_id=cloud_task_id,
                cloud_region=(
                    self.settings.bailian_asr.region
                    if options.engine == TranscriptionEngine.BAILIAN
                    else None
                ),
            )
        )
        return job.model_copy(deep=True)

    def resolve_cloud_submission(
        self,
        asset_id: str,
        job_id: str,
        cloud_task_id: str | None,
        confirm_not_submitted: bool,
    ) -> TranscriptionMetadata:
        """只有用户核实供应商任务后才解除不确定状态，恢复本身不提交收费请求。"""
        with self._lock:
            if self._active_job_for(asset_id) is not None:
                raise AnalysisPrerequisiteError("请先等待当前分析任务停止")
            metadata = self.library.load_transcription_metadata(asset_id)
            if metadata is None or metadata.job_id != job_id:
                raise AnalysisPrerequisiteError("转写记录已更新，请重新打开转写窗口")
            if not metadata.cloud_submission_uncertain:
                raise AnalysisPrerequisiteError("云端提交状态已经确认，请重新读取任务")
            if bool(cloud_task_id) == confirm_not_submitted:
                raise AnalysisPrerequisiteError(
                    "请填写已有任务号，或确认未生成云端任务"
                )
            if (
                cloud_task_id
                and metadata.cloud_region != self.settings.bailian_asr.region
            ):
                raise AnalysisPrerequisiteError(
                    "请先将百炼服务地域切回原任务地域，再关联任务号"
                )
            resolved = metadata.model_copy(
                update={
                    "cloud_task_id": cloud_task_id,
                    "cloud_submission_uncertain": False,
                }
            )
            self.library.save_transcription_metadata(resolved)
            return resolved

    def create_initialization(self, asset_id: str) -> AnalysisJob:
        """为就绪素材创建无需用户决策的本地渐进分析任务。"""

        self._check_accepting_jobs()
        asset = self.library.get(asset_id)
        if not asset or asset.status != MediaAssetStatus.READY:
            raise AnalysisError("视频尚未就绪，无法初始化")
        active_job = self._active_job_for(asset_id)
        if active_job:
            return active_job
        transcript = self.library.load_transcript(asset_id)
        previous_metadata = self.library.load_transcription_metadata(asset_id)
        if (
            transcript is None
            and previous_metadata
            and previous_metadata.cloud_submission_uncertain
        ):
            raise AnalysisPrerequisiteError(CLOUD_SUBMISSION_UNCERTAIN_MESSAGE)
        segments = self.library.load_segments(asset_id)
        capabilities = self._existing_capabilities(transcript, segments)
        if (
            transcript is not None
            and segments
            and AnalysisCapability.KEY_FRAMES in capabilities
            and not _needs_local_chapter_rebuild(transcript, segments)
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
                    cloud_region=(
                        self.settings.bailian_asr.region
                        if self.settings.default_transcription.engine
                        == TranscriptionEngine.BAILIAN
                        else None
                    ),
                )
            )
        return job.model_copy(deep=True)

    def create_chapters(self, asset_id: str) -> AnalysisJob:
        """用户主动重建章节时复用现有字幕，并在整批结果有效后替换旧章节。"""
        self._check_accepting_jobs()
        asset = self.library.get(asset_id)
        if not asset or asset.status != MediaAssetStatus.READY:
            raise AnalysisError("视频尚未就绪，无法生成章节")
        transcript = self.library.load_transcript(asset_id)
        if transcript is None or not transcript.segments:
            raise AnalysisPrerequisiteError("请先完成视频转录，再生成语义章节")
        active_job = self._active_job_for(asset_id)
        if active_job:
            if active_job.operation == AnalysisOperation.CHAPTERS:
                return active_job
            raise AnalysisPrerequisiteError("视频已有分析任务，请等待完成后再生成章节")
        model_ids = [
            self.settings.agent.complex_model_id,
            self.settings.agent.fast_model_id,
            self.settings.agent.vision_model_id,
        ]
        model = next(
            (
                candidate
                for model_id in model_ids
                if model_id
                and (candidate := self.settings.ai_model(model_id)) is not None
            ),
            None,
        )
        if model is None:
            model = next(iter(self.settings.online_ai_models), None)
        if model is None:
            raise AnalysisPrerequisiteError("请先在设置中配置 AI 模型，再生成章节")
        job = AnalysisJob(
            job_id=f"job-{uuid7().hex}",
            asset_id=asset_id,
            operation=AnalysisOperation.CHAPTERS,
            ai_model_id=model.model_id,
            strategy=AnalysisStrategy(depth=AnalysisDepth.DEEP),
            message="等待生成章节",
            proposal_base_digest=_chapter_source_digest(
                self.library.load_segments(asset_id), transcript
            ),
        )
        with self._lock:
            self._jobs[job.job_id] = job
            self._active_job_id_by_asset_id[asset_id] = job.job_id
        self.library.save_analysis_job(job)
        return job.model_copy(deep=True)

    def initialize_asset(self, asset_id: str) -> AnalysisJob:
        job = self.create_initialization(asset_id)
        if job.stage not in TERMINAL_ANALYSIS_STAGES:
            self.start(job.job_id)
        return job

    def start(self, job_id: str) -> None:
        with self._lock:
            self._check_accepting_jobs()
            job = self._jobs.get(job_id)
            if (
                job is None
                or job.stage in INACTIVE_ANALYSIS_STAGES
                or job.stage == AnalysisStage.CANCELLING
            ):
                return
            current = self._tasks.get(job_id)
            if current and not current.done():
                return
            self._cancel_events.setdefault(job_id, Event())
            self._event_loop = asyncio.get_running_loop()
            task = asyncio.create_task(self._run(job_id))
            self._tasks[job_id] = task
            task.add_done_callback(lambda done: self._discard_task(job_id, done))

    def restore(self) -> None:
        """服务重启后恢复未完成任务，复用已经落盘的转写与事件产物。"""
        for saved_job in self.library.load_analysis_jobs():
            job = saved_job.model_copy(deep=True)
            if job.stage == AnalysisStage.CANCELLING:
                with self._lock:
                    self._jobs[job.job_id] = job
                self._finish_cancelled(job.job_id)
                continue
            if job.stage not in INACTIVE_ANALYSIS_STAGES:
                job.stage = AnalysisStage.PENDING
                job.message = "等待恢复分析"
                job.error_message = None
                with self._lock:
                    self._active_job_id_by_asset_id[job.asset_id] = job.job_id
            with self._lock:
                self._jobs[job.job_id] = job
            metadata = self.library.load_transcription_metadata(job.asset_id)
            if metadata and metadata.job_id == job.job_id:
                self._transcription_options_by_job_id[job.job_id] = metadata.options
            if job.stage == AnalysisStage.PENDING:
                self.start(job.job_id)

    async def close(self) -> None:
        with self._lock:
            self._closing = True
            job_ids = [
                job.job_id
                for job in self._jobs.values()
                if job.stage not in INACTIVE_ANALYSIS_STAGES
            ]
        for job_id in job_ids:
            self.cancel(job_id)
        if self._tasks:
            await asyncio.gather(*list(self._tasks.values()), return_exceptions=True)
        async with self._worker_reap_lock:
            await self._worker.close()
            for job_id in list(self._unreaped_work_directories):
                await self._release_reaped_job(job_id)

    def get(self, job_id: str) -> AnalysisJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return job.model_copy(deep=True) if job else None

    def list_jobs(self, history_limit: int) -> list[AnalysisJob]:
        """任务中心必须保留全部可操作任务，历史条数只限制已经结束的记录。"""
        with self._lock:
            jobs = sorted(
                self._jobs.values(), key=lambda job: job.updated_at, reverse=True
            )
            active_jobs = [
                job for job in jobs if job.stage not in TERMINAL_ANALYSIS_STAGES
            ]
            history = [job for job in jobs if job.stage in TERMINAL_ANALYSIS_STAGES]
            return [
                job.model_copy(deep=True)
                for job in [*active_jobs, *history[:history_limit]]
            ]

    def has_active_jobs(self) -> bool:
        with self._lock:
            return any(
                job.stage not in INACTIVE_ANALYSIS_STAGES for job in self._jobs.values()
            )

    def cancel(self, job_id: str) -> AnalysisJob:
        """排队任务立即退出，运行任务确认进程树退出后才释放执行名额。"""
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise AnalysisError("分析任务不存在")
            if job.stage in INACTIVE_ANALYSIS_STAGES:
                return job.model_copy(deep=True)
            self._cancel_events.setdefault(job_id, Event()).set()
            if job_id not in self._running_job_ids:
                task = self._tasks.get(job_id)
                if task is not None:
                    task.get_loop().call_soon_threadsafe(task.cancel)
                self._finish_cancelled(job_id)
            else:
                job.stage = AnalysisStage.CANCELLING
                job.message = "正在停止，等待当前步骤安全结束"
                job.error_message = None
                job.updated_at = datetime.now(UTC)
                self.library.save_analysis_job(job)
                task = self._tasks.get(job_id)
                if (task is None or task.done()) and self._event_loop is not None:
                    self._event_loop.call_soon_threadsafe(self._start_reaper, job_id)
            return job.model_copy(deep=True)

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
            # 分析进程退出前仍可能读取素材，必须先完成停止再删除目录。
            return False
        for job in jobs:
            self.cancel(job.job_id)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        return all(task.done() for task in tasks)

    def _discard_task(self, job_id: str, task: asyncio.Task) -> None:
        with self._lock:
            if self._tasks.get(job_id) is not task:
                return
            self._tasks.pop(job_id, None)
            if job_id not in self._running_job_ids:
                self._cancel_events.pop(job_id, None)

    def _start_reaper(self, job_id: str) -> None:
        with self._lock:
            current = self._tasks.get(job_id)
            if job_id not in self._unreaped_work_directories or (
                current is not None and not current.done()
            ):
                return
            task = asyncio.create_task(self._reap_worker(job_id))
            self._tasks[job_id] = task
            task.add_done_callback(lambda done: self._discard_task(job_id, done))

    async def _reap_worker(self, job_id: str) -> bool:
        """系统回收暂时失败时保留所有权，后续停止请求可重试同一回收流程。"""
        for attempt in range(WORKER_REAP_ATTEMPTS):
            try:
                async with self._worker_reap_lock:
                    if job_id not in self._unreaped_work_directories:
                        return True
                    await self._worker.close()
                    await self._release_reaped_job(job_id)
            except AnalysisWorkerNotStopped as error:
                with self._lock:
                    job = self._jobs[job_id]
                    job.error_message = str(error)
                    job.updated_at = datetime.now(UTC)
                    self.library.save_analysis_job(job)
                if attempt + 1 < WORKER_REAP_ATTEMPTS:
                    await asyncio.sleep(WORKER_REAP_RETRY_SECONDS)
            else:
                return True
        return False

    async def _release_reaped_job(self, job_id: str) -> None:
        work_directory = self._unreaped_work_directories.get(job_id)
        if work_directory is not None:
            await asyncio.to_thread(shutil.rmtree, work_directory, True)
        with self._lock:
            self._finish_cancelled(job_id)
            self._running_job_ids.discard(job_id)
            self._cancel_events.pop(job_id, None)
            self._unreaped_work_directories.pop(job_id, None)
            if not self._unreaped_work_directories:
                self._worker_available.set()

    def _check_cancellation(self, job_id: str) -> None:
        check_analysis_cancellation(self._cancel_events.get(job_id))

    def _finish_cancelled(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or job.stage in TERMINAL_ANALYSIS_STAGES:
                return
            job.stage = AnalysisStage.CANCELLED
            job.message = "分析已停止"
            job.error_message = None
            job.updated_at = datetime.now(UTC)
            self.library.save_analysis_job(job)
            metadata = self.library.load_transcription_metadata(job.asset_id)
            if (
                metadata is not None
                and metadata.job_id == job_id
                and metadata.status
                in {TranscriptionStatus.PENDING, TranscriptionStatus.RUNNING}
            ):
                self.library.save_transcription_metadata(
                    metadata.model_copy(
                        update={
                            "status": TranscriptionStatus.CANCELLED,
                            "completed_at": datetime.now(UTC),
                            "error_message": None,
                        }
                    )
                )
            if self._active_job_id_by_asset_id.get(job.asset_id) == job_id:
                self._active_job_id_by_asset_id.pop(job.asset_id, None)

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
        self._event_loop = asyncio.get_running_loop()
        job = self.get(job_id)
        if not job or job.stage in INACTIVE_ANALYSIS_STAGES:
            return
        asset = self.library.get(job.asset_id)
        if not asset:
            self._fail(job_id, "找不到分析任务对应的媒体资源")
            return

        async with self._analysis_lock:
            await self._worker_available.wait()
            with self._lock:
                if self._jobs[job_id].stage in INACTIVE_ANALYSIS_STAGES:
                    return
                self._cancel_events.setdefault(job_id, Event())
                self._running_job_ids.add(job_id)
                self._jobs[job_id].started_at = datetime.now(UTC)
                self.library.save_analysis_job(self._jobs[job_id])
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
            worker_not_stopped = False
            work_directory = None
            try:
                self._check_cancellation(job_id)
                work_directory = self.library.temporary_directory(job_id)
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
                    cloud_task_id = None
                    cloud_region = None
                    if transcription_options.engine == TranscriptionEngine.BAILIAN:
                        cloud_region = self.settings.bailian_asr.region
                        if saved_metadata and saved_metadata.job_id == job_id:
                            cloud_task_id = saved_metadata.cloud_task_id
                            cloud_region = saved_metadata.cloud_region or cloud_region
                    self.library.save_transcription_metadata(
                        TranscriptionMetadata(
                            job_id=job_id,
                            asset_id=asset.asset_id,
                            status=TranscriptionStatus.RUNNING,
                            attempt_count=attempt_count,
                            engine=transcription_options.engine,
                            options=transcription_options,
                            cloud_task_id=cloud_task_id,
                            cloud_submission_uncertain=saved_metadata.cloud_submission_uncertain
                            if saved_metadata
                            else False,
                            cloud_region=cloud_region,
                            started_at=transcription_started_at,
                        )
                    )
                    self._update_job(
                        job_id, AnalysisStage.EXTRACTING_AUDIO, 0, "正在读取平台字幕"
                    )
                    transcription_result = await self._worker.execute(
                        self._transcription_request(
                            job, transcription_options, asset, playback, work_directory
                        ),
                        self._cancel_events[job_id],
                        lambda progress: self._worker_progress(job, progress),
                    )
                    if not isinstance(transcription_result, TranscriptionResult):
                        raise AnalysisError("分析进程未返回有效转录")
                    self._check_cancellation(job_id)
                    transcript = _bound_transcript_to_media(
                        transcription_result.transcript,
                        asset.duration_seconds,
                    )
                    self._update_job(
                        job_id,
                        AnalysisStage.TRANSCRIBING,
                        TRANSCRIPTION_SAVE_PROGRESS_PERCENT,
                        "正在保存完整转录",
                    )
                    with self._lock:
                        self._check_cancellation(job_id)
                        self.library.save_transcript(transcript)
                    self._on_evidence_ready()
                    completed_at = datetime.now(UTC)
                    cloud_metadata = self.library.load_transcription_metadata(
                        asset.asset_id
                    )
                    self.library.save_transcription_metadata(
                        TranscriptionMetadata(
                            job_id=job_id,
                            asset_id=asset.asset_id,
                            status=TranscriptionStatus.COMPLETE,
                            attempt_count=attempt_count,
                            engine=transcription_options.engine,
                            output_source=transcription_result.output_source,
                            options=transcription_options,
                            cloud_submission_uncertain=cloud_metadata.cloud_submission_uncertain
                            if cloud_metadata
                            else False,
                            cloud_task_id=cloud_metadata.cloud_task_id
                            if cloud_metadata
                            else None,
                            cloud_region=cloud_metadata.cloud_region
                            if cloud_metadata
                            else None,
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

                model = (
                    None
                    if job.operation == AnalysisOperation.INITIALIZATION
                    else self.settings.ai_model(job.ai_model_id)
                    if job.ai_model_id
                    else None
                )
                if (
                    job.ai_model_id
                    and job.operation != AnalysisOperation.INITIALIZATION
                    and model is None
                ):
                    raise AnalysisPrerequisiteError("分析任务使用的 AI 模型已被删除")
                self._update_job(
                    job_id, AnalysisStage.BUILDING_TIMELINE, 70, "正在构建时间轴事件"
                )
                markers = self.library.load_markers(job.asset_id)
                staged_artifacts = work_directory / "artifacts"
                if staged_artifacts.is_symlink():
                    raise AnalysisError("分析暂存目录不能是符号链接")
                segments = await self._worker.execute(
                    TimelineRequest(
                        transcript=transcript,
                        media_path=playback,
                        asset_id=asset.asset_id,
                        artifacts_directory=staged_artifacts,
                        duration_seconds=asset.duration_seconds,
                        settings=self.settings.model_copy(deep=True),
                        markers=markers,
                        strategy=job.strategy,
                        model=model,
                    ),
                    self._cancel_events[job_id],
                    lambda progress: self._worker_progress(job, progress),
                )
                if not isinstance(segments, list) or any(
                    not isinstance(segment, MediaSegment) for segment in segments
                ):
                    raise AnalysisError("分析进程未返回有效章节")
                self._check_cancellation(job_id)
                for segment in segments:
                    segment.key_frame_paths = [
                        f"artifacts/{relative_path}"
                        for relative_path in segment.key_frame_paths
                    ]
                completed_stage = (
                    AnalysisStage.DESCRIBING_VISUALS
                    if model is not None
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
                has_ocr_text = any(
                    segment.ocr_text or segment.formula_latex
                    for segment in proposed_segments
                )
                if has_ocr_text:
                    self._add_capability(job_id, AnalysisCapability.OCR)
                if model is not None and any(
                    segment.visual_description for segment in proposed_segments
                ):
                    self._add_capability(job_id, AnalysisCapability.VISUAL)
                if job.operation == AnalysisOperation.CHAPTERS:
                    with self._lock, self.library._lock:
                        self._check_cancellation(job_id)
                        if (
                            _chapter_source_digest(
                                self.library.load_segments(job.asset_id),
                                self.library.load_transcript(job.asset_id),
                            )
                            != job.proposal_base_digest
                        ):
                            raise AnalysisError(
                                "生成期间字幕或章节已被更新，请重新生成"
                            )
                        self._publish_frames(job, staged_artifacts, proposed_segments)
                        self.library.save_segments(job.asset_id, proposed_segments)
                    self._on_evidence_ready()
                    self._update_job(
                        job_id,
                        AnalysisStage.COMPLETE,
                        100,
                        f"已生成 {len(proposed_segments)} 个章节及摘要",
                    )
                    return
                if job.operation == AnalysisOperation.INITIALIZATION:
                    with self._lock:
                        self._check_cancellation(job_id)
                        self._publish_frames(job, staged_artifacts, proposed_segments)
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
                    if model is not None
                    else "音频时间轴预览已生成，等待确认（未配置视觉模型）"
                )
                with self._lock:
                    self._check_cancellation(job_id)
                    self._publish_frames(job, staged_artifacts, proposed_segments)
                    self._set_analysis_proposal(
                        job_id,
                        _segment_digest(self.library.load_segments(asset.asset_id)),
                        proposed_segments,
                        message,
                    )
            except AnalysisWorkerNotStopped as error:
                worker_not_stopped = True
                with self._lock:
                    self._unreaped_work_directories[job_id] = work_directory
                    self._worker_available.clear()
                    current = self._jobs[job_id]
                    current.stage = AnalysisStage.CANCELLING
                    current.message = "等待分析进程退出，暂时无法重试"
                    current.error_message = str(error)
                    current.updated_at = datetime.now(UTC)
                    self.library.save_analysis_job(current)
                worker_not_stopped = not await self._reap_worker(job_id)
            except AnalysisCancelled:
                self._finish_cancelled(job_id)
            except Exception as error:
                if self._cancel_events[job_id].is_set():
                    self._finish_cancelled(job_id)
                    return
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
                    cloud_metadata = self.library.load_transcription_metadata(
                        asset.asset_id
                    )
                    cloud_task_id = (
                        cloud_metadata.cloud_task_id if cloud_metadata else None
                    )
                    if isinstance(error, BailianAsrError) and error.terminal_task:
                        cloud_task_id = None
                    self.library.save_transcription_metadata(
                        TranscriptionMetadata(
                            job_id=job_id,
                            asset_id=asset.asset_id,
                            status=TranscriptionStatus.FAILED,
                            cloud_submission_uncertain=cloud_metadata.cloud_submission_uncertain
                            if cloud_metadata
                            else False,
                            attempt_count=attempt_count,
                            engine=transcription_options.engine,
                            options=transcription_options,
                            cloud_task_id=cloud_task_id,
                            cloud_region=cloud_metadata.cloud_region
                            if cloud_metadata
                            else None,
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
                if not worker_not_stopped:
                    if work_directory is not None:
                        await asyncio.to_thread(shutil.rmtree, work_directory, True)
                    with self._lock:
                        self._running_job_ids.discard(job_id)
                        if self._active_job_id_by_asset_id.get(job.asset_id) == job_id:
                            self._active_job_id_by_asset_id.pop(job.asset_id, None)

    def _transcription_request(
        self,
        job: AnalysisJob,
        options: TranscriptionOptions,
        asset: MediaAsset,
        playback: Path,
        work_directory: Path,
    ) -> TranscriptionRequest:
        metadata = self.library.load_transcription_metadata(asset.asset_id)
        region = None
        api_key = None
        credential_error = None
        if options.engine == TranscriptionEngine.BAILIAN:
            if metadata and metadata.cloud_submission_uncertain:
                raise AnalysisPrerequisiteError(CLOUD_SUBMISSION_UNCERTAIN_MESSAGE)
            region = (
                metadata.cloud_region
                if metadata and metadata.cloud_region is not None
                else self.settings.bailian_asr.region
            )
            try:
                api_key = self._require_bailian_credentials(options, region)
            except BailianCredentialError as error:
                # 自动初始化仍可读取平台字幕，缺少密钥只应阻止实际 ASR。
                credential_error = str(error)
        return TranscriptionRequest(
            asset_id=asset.asset_id,
            media_path=playback,
            source_url=asset.source_url,
            work_directory=work_directory,
            settings=self.settings.model_copy(deep=True),
            options=options,
            context=self._transcription_context(asset),
            prepare_model=job.operation == AnalysisOperation.INITIALIZATION,
            duration_seconds=asset.duration_seconds,
            cloud_api_key=api_key,
            cloud_task_id=metadata.cloud_task_id if metadata else None,
            cloud_region=region,
            cloud_credential_error=credential_error,
        )

    def _worker_progress(self, job: AnalysisJob, progress: WorkerProgress) -> None:
        if isinstance(progress, CloudTaskSubmitted):
            self._save_cloud_task_id(job.asset_id, job.job_id, progress.task_id)
        elif isinstance(progress, CloudSubmissionState):
            with self._lock:
                metadata = self.library.load_transcription_metadata(job.asset_id)
                if metadata is None or metadata.job_id != job.job_id:
                    raise AnalysisError("云端转写任务状态已变更，已停止处理")
                self.library.save_transcription_metadata(
                    metadata.model_copy(
                        update={"cloud_submission_uncertain": progress.uncertain}
                    )
                )
        elif isinstance(progress, StageProgress):
            self._update_job(
                job.job_id,
                progress.stage,
                progress.percent,
                progress.message,
                progress_known=progress.progress_known,
            )
        elif isinstance(progress, ModelProgress):
            self._report_model_progress(
                job.job_id,
                progress.name,
                progress.downloaded_bytes,
                progress.total_bytes,
            )
        else:
            self._report_transcription_progress(job.job_id, progress)

    def _publish_frames(
        self, job: AnalysisJob, staging: Path, segments: list[MediaSegment]
    ) -> None:
        """计算结果先隔离，只有仍有效的当前任务可以把关键帧发布到素材。"""
        self._check_cancellation(job.job_id)
        if (
            self._active_job_id_by_asset_id.get(job.asset_id) != job.job_id
            or self.library.get(job.asset_id) is None
        ):
            raise AnalysisError("分析任务对应的素材状态已变更")
        target_directory = self.library.artifacts_directory(job.asset_id)
        if (
            target_directory.is_symlink()
            or not target_directory.resolve().is_relative_to(
                self.library.asset_directory(job.asset_id).resolve()
            )
        ):
            raise AnalysisError("分析产物目录不能超出素材")
        files_to_publish = []
        for relative_path in dict.fromkeys(
            path for segment in segments for path in segment.key_frame_paths
        ):
            path = Path(relative_path)
            if (
                path.is_absolute()
                or ".." in path.parts
                or not path.parts
                or path.parts[0] != "artifacts"
            ):
                raise AnalysisError("分析进程返回了无效关键帧路径")
            local_path = path.relative_to("artifacts")
            source = staging / local_path
            target = target_directory / local_path
            if (
                not source.is_file()
                or source.is_symlink()
                or not source.resolve().is_relative_to(staging.resolve())
                or target.exists()
                or not target.resolve().is_relative_to(target_directory.resolve())
            ):
                raise AnalysisError("分析关键帧缺失或目标路径冲突")
            files_to_publish.append((source, target))
        for source, target in files_to_publish:
            target.parent.mkdir(parents=True, exist_ok=True)
            source.rename(target)

    def _require_bailian_credentials(
        self, options: TranscriptionOptions, region: BailianRegion | None = None
    ) -> str:
        """地域和模型必须匹配，避免将密钥或收费请求发送到错误地域。"""
        region = region or self.settings.bailian_asr.region
        if (
            region == BailianRegion.SINGAPORE
            and options.model == BAILIAN_PARAFORMER_MODEL
        ):
            raise BailianCredentialError("Paraformer 仅支持北京地域，请选择 Fun-ASR")
        return self._bailian_credentials.require_api_key(region)

    def _save_cloud_task_id(self, asset_id: str, job_id: str, task_id: str) -> None:
        """先落盘供应商任务号，重启后继续查询同一笔转写。"""
        with self._lock:
            metadata = self.library.load_transcription_metadata(asset_id)
            if metadata is None or metadata.job_id != job_id:
                raise AnalysisError("云端转写任务状态已变更，已停止处理")
            self.library.save_transcription_metadata(
                metadata.model_copy(
                    update={
                        "cloud_task_id": task_id,
                        "cloud_submission_uncertain": False,
                    }
                )
            )

    def _transcription_context(self, asset: MediaAsset) -> str:
        candidates = [asset.title, asset.author_name]
        if asset.folder_id is not None:
            folder = self.library.get_folder(asset.folder_id)
            candidates.insert(1, folder.name)
        normalized_parts: list[str] = []
        known_parts: set[str] = set()
        for candidate in candidates:
            normalized = " ".join((candidate or "").split())
            normalized_key = normalized.casefold()
            if not normalized or normalized_key in known_parts:
                continue
            normalized_parts.append(normalized)
            known_parts.add(normalized_key)
        return "；".join(normalized_parts)[:TRANSCRIPTION_CONTEXT_MAX_CHARACTERS]

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
            self._check_cancellation(job_id)
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
            self._check_cancellation(job_id)
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
        *,
        progress_known: bool = False,
    ) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job or job.stage in TERMINAL_ANALYSIS_STAGES:
                return
            self._check_cancellation(job_id)
            job.stage = stage
            job.progress_percent = min(max(progress_percent, job.progress_percent), 100)
            job.progress_known = progress_known or stage == AnalysisStage.COMPLETE
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
            AnalysisOperation.CHAPTERS: "章节生成失败",
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
            progress_known=total_bytes > 0,
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
            progress_known=total_seconds > 0 and completed_seconds > 0,
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
        if any(segment.ocr_text or segment.formula_latex for segment in segments):
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
