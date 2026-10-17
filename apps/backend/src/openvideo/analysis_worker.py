"""把模型和媒体计算留在专属进程，主进程独占任务状态与资料库发布。"""

from __future__ import annotations

import asyncio
import errno
import multiprocessing
import os
import signal
import socket
import subprocess
from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import dataclass
from multiprocessing.connection import Connection
from pathlib import Path
from threading import Event, Thread
from time import monotonic
from typing import Protocol

from openvideo.core.ai_models import AiModelConfiguration, IMAGE_INPUT_MODALITY
from openvideo.core.analysis_models import AnalysisStage, AnalysisStrategy
from openvideo.core.bailian_models import BailianAsrConfiguration, BailianRegion
from openvideo.core.media_models import MediaMarker, MediaSegment
from openvideo.core.transcription_models import (
    Transcript,
    TranscriptionEngine,
    TranscriptionOptions,
)
from openvideo.settings import Settings
from openvideo.tools.analysis_pipeline import build_segments
from openvideo.tools.bailian_asr import BailianAsrError, BailianTranscriber
from openvideo.tools.cancellation import AnalysisCancelled, check_analysis_cancellation
from openvideo.tools.ocr import LocalOcrReader
from openvideo.tools.transcribe import (
    TranscriptionProgress,
    TranscriptionResult,
    create_transcriber,
    require_transcription_adapter,
    transcribe_media,
)
from openvideo.transcription_model_manager import (
    download_transcription_model,
    is_transcription_model_installed,
)


WORKER_POLL_SECONDS = 0.05
WORKER_STOP_GRACE_SECONDS = 1.0
WORKER_TERMINATE_GRACE_SECONDS = 1.0
WORKER_KILL_GRACE_SECONDS = 2.0
WORKER_START_TIMEOUT_SECONDS = 30.0
WORKER_ACK_TIMEOUT_SECONDS = 10.0
WORKER_IO_STOP_TIMEOUT_SECONDS = 0.5
WINDOWS_IO_NOT_FOUND = 1168
# 正常推理可持续较久，硬上限限制无进度、无响应的第三方模型调用。
TRANSCRIPTION_DEADLINE_SECONDS = 6 * 60 * 60
TIMELINE_DEADLINE_SECONDS = 2 * 60 * 60


@dataclass(frozen=True)
class TranscriptionRequest:
    asset_id: str
    media_path: Path
    source_url: str
    work_directory: Path
    settings: Settings
    options: TranscriptionOptions
    context: str
    prepare_model: bool
    duration_seconds: float | None
    cloud_api_key: str | None = None
    cloud_task_id: str | None = None
    cloud_region: BailianRegion | None = None
    cloud_credential_error: str | None = None


@dataclass(frozen=True)
class TimelineRequest:
    transcript: Transcript
    media_path: Path
    asset_id: str
    artifacts_directory: Path
    duration_seconds: float | None
    settings: Settings
    markers: list[MediaMarker]
    strategy: AnalysisStrategy
    model: AiModelConfiguration | None


@dataclass(frozen=True)
class StageProgress:
    stage: AnalysisStage
    percent: float
    message: str


@dataclass(frozen=True)
class ModelProgress:
    name: str
    downloaded_bytes: int
    total_bytes: int


@dataclass(frozen=True)
class CloudTaskSubmitted:
    task_id: str


@dataclass(frozen=True)
class CloudSubmissionState:
    uncertain: bool


WorkerProgress = (
    StageProgress
    | ModelProgress
    | TranscriptionProgress
    | CloudTaskSubmitted
    | CloudSubmissionState
)
WorkerRequest = TranscriptionRequest | TimelineRequest
WorkerResult = TranscriptionResult | list[MediaSegment]


@dataclass(frozen=True)
class WorkerReady:
    pass


@dataclass(frozen=True)
class WorkerSuccess:
    result: WorkerResult


@dataclass(frozen=True)
class WorkerFailure:
    message: str
    cloud_task_terminal: bool = False
    cancelled: bool = False


class AnalysisWorker(Protocol):
    """执行器返回或抛错前需结束本次计算；未确认退出必须使用专门异常。"""

    async def execute(
        self,
        request: WorkerRequest,
        cancel_event: Event,
        on_progress: Callable[[WorkerProgress], None],
    ) -> WorkerResult: ...

    async def close(self) -> None: ...


class AnalysisWorkerNotStopped(RuntimeError):
    """系统尚未确认进程树退出时，任务必须保留停止中与素材占用。"""


def prepare_worker_transcriber(
    request: TranscriptionRequest,
    cancel_event: Event,
    report: Callable[[WorkerProgress], None],
):
    """平台字幕缺失后准备模型；提交云任务后先让主进程保存任务号。"""
    check_analysis_cancellation(cancel_event)
    options = request.options
    if options.engine == TranscriptionEngine.BAILIAN:
        if request.cloud_api_key is None or request.cloud_region is None:
            raise RuntimeError(
                request.cloud_credential_error or "请在设置中配置百炼 API Key"
            )
        report(StageProgress(AnalysisStage.TRANSCRIBING, 10, "正在准备百炼云端转写"))
        return BailianTranscriber(
            options,
            request.cloud_api_key,
            BailianAsrConfiguration(region=request.cloud_region).base_url,
            cancellation_check=lambda: check_analysis_cancellation(cancel_event),
            task_id=request.cloud_task_id,
            on_task_submitted=lambda task_id: report(CloudTaskSubmitted(task_id)),
            on_submission_started=lambda: report(CloudSubmissionState(True)),
            on_submission_rejected=lambda: report(CloudSubmissionState(False)),
            on_status=lambda message: report(
                StageProgress(AnalysisStage.TRANSCRIBING, 10, message)
            ),
            duration_seconds=request.duration_seconds,
        )
    if request.prepare_model:
        descriptor = require_transcription_adapter(options)
        if not is_transcription_model_installed(
            descriptor, request.settings.models_root_directory
        ):
            report(
                StageProgress(
                    AnalysisStage.PREPARING_TRANSCRIPTION_MODEL,
                    1,
                    f"正在准备本地转录模型：{descriptor.name}",
                )
            )
            download_transcription_model(
                descriptor,
                request.settings.models_root_directory,
                lambda downloaded, total: report(
                    ModelProgress(descriptor.name, downloaded, total)
                ),
            )
    report(StageProgress(AnalysisStage.EXTRACTING_AUDIO, 5, "正在提取音频"))
    return create_transcriber(
        options,
        request.settings.models_root_directory,
        progress_reporter=report,
        context=request.context,
        cancellation_check=lambda: check_analysis_cancellation(cancel_event),
    )


def execute_worker_request(
    request: WorkerRequest,
    cancel_event: Event,
    report: Callable[[WorkerProgress], None],
    ocr_reader: LocalOcrReader,
) -> WorkerResult:
    if isinstance(request, TranscriptionRequest):
        return transcribe_media(
            request.media_path,
            request.asset_id,
            request.source_url,
            request.work_directory,
            request.settings.ffmpeg_path,
            request.settings.ffmpeg_bin_dir,
            lambda: prepare_worker_transcriber(request, cancel_event, report),
            cancel_event=cancel_event,
        )
    from openvideo.tools.vision import LiteLlmVision

    describer = (
        LiteLlmVision(request.model)
        if request.model is not None
        and IMAGE_INPUT_MODALITY in request.model.input_modalities
        else None
    )
    return build_segments(
        request.transcript,
        request.media_path,
        request.asset_id,
        request.artifacts_directory,
        request.duration_seconds,
        request.settings,
        describer,
        request.markers,
        request.strategy,
        lambda stage, percent, message: report(StageProgress(stage, percent, message)),
        request.model,
        ocr_reader.read_frames,
        ocr_reader.read_formulas,
        cancel_event,
    )


def analysis_worker_main(connection: Connection, cancel_event: Event) -> None:
    if os.name == "posix":
        os.setsid()
    reader: LocalOcrReader | None = None
    models_directory: Path | None = None
    connection.send(WorkerReady())

    def report(progress: WorkerProgress) -> None:
        # 云任务号即使在停止请求之后返回，也必须先保存再响应取消。
        if not isinstance(progress, CloudTaskSubmitted | CloudSubmissionState):
            check_analysis_cancellation(cancel_event)
        connection.send(progress)
        if isinstance(progress, CloudTaskSubmitted | CloudSubmissionState):
            if (
                not connection.poll(WORKER_ACK_TIMEOUT_SECONDS)
                or connection.recv() is not True
            ):
                raise RuntimeError("云端任务号未确认保存，请核实任务后重试")
        check_analysis_cancellation(cancel_event)

    try:
        while True:
            request = connection.recv()
            if request is None:
                return
            if not isinstance(request, TranscriptionRequest | TimelineRequest):
                raise RuntimeError("分析进程请求无效")
            if (
                reader is None
                or models_directory != request.settings.models_root_directory
            ):
                models_directory = request.settings.models_root_directory
                reader = LocalOcrReader(models_root_directory=models_directory)
            try:
                result = execute_worker_request(request, cancel_event, report, reader)
                check_analysis_cancellation(cancel_event)
                connection.send(WorkerSuccess(result))
            except AnalysisCancelled:
                connection.send(WorkerFailure("分析已停止", cancelled=True))
            except Exception as error:
                connection.send(
                    WorkerFailure(
                        str(error) or "分析进程执行失败",
                        cloud_task_terminal=isinstance(error, BailianAsrError)
                        and error.terminal_task,
                    )
                )
    except (EOFError, BrokenPipeError, OSError):
        return
    finally:
        connection.close()


class AnalysisProcessWorker:
    """单任务常驻进程复用 OCR；强制停止后连同 IPC 整体丢弃，下一任务重建。"""

    def __init__(
        self,
        *,
        stop_grace_seconds: float = WORKER_STOP_GRACE_SECONDS,
        worker_entrypoint: Callable[[Connection, Event], None] = analysis_worker_main,
    ):
        self._context = multiprocessing.get_context("spawn")
        self._process = None
        self._connection: Connection | None = None
        self._cancel_event = None
        self._session_ready = False
        self._stop_grace_seconds = stop_grace_seconds
        self._windows_job = None
        self._worker_entrypoint = worker_entrypoint
        self._stopping = False
        self._io_threads: dict[Future, Thread] = {}

    async def execute(
        self,
        request: WorkerRequest,
        cancel_event: Event,
        on_progress: Callable[[WorkerProgress], None],
    ) -> WorkerResult:
        check_analysis_cancellation(cancel_event)
        await self._ensure_started(cancel_event)
        connection = self._connection
        assert connection is not None and self._cancel_event is not None
        self._cancel_event.clear()
        deadline = monotonic() + (
            TRANSCRIPTION_DEADLINE_SECONDS
            if isinstance(request, TranscriptionRequest)
            else TIMELINE_DEADLINE_SECONDS
        )
        stopping_at = None
        receive_operation = None
        try:
            send_operation = self._start_pipe_operation(
                lambda: connection.send(request)
            )
            while True:
                if cancel_event.is_set() and stopping_at is None:
                    self._cancel_event.set()
                    stopping_at = monotonic() + self._stop_grace_seconds
                if stopping_at is not None and monotonic() >= stopping_at:
                    await self.close()
                    raise AnalysisCancelled("分析已停止")
                if monotonic() >= deadline:
                    await self.close()
                    raise RuntimeError(
                        "分析步骤超过执行时限，请缩短视频或更换模型后重试"
                    )
                if send_operation is not None:
                    if not send_operation.done():
                        await asyncio.sleep(WORKER_POLL_SECONDS)
                        continue
                    send_operation.result()
                    send_operation = None
                if receive_operation is None:
                    if not connection.poll():
                        await asyncio.sleep(WORKER_POLL_SECONDS)
                        continue
                    receive_operation = self._start_pipe_operation(connection.recv)
                if not receive_operation.done():
                    await asyncio.sleep(WORKER_POLL_SECONDS)
                    continue
                message = receive_operation.result()
                receive_operation = None
                if isinstance(message, WorkerSuccess):
                    check_analysis_cancellation(cancel_event)
                    return message.result
                if isinstance(message, WorkerFailure):
                    if message.cancelled or cancel_event.is_set():
                        # 协作退出也回收整棵进程树，不能遗留第三方模型的子进程。
                        await self.close()
                        raise AnalysisCancelled("分析已停止")
                    if message.cloud_task_terminal:
                        raise BailianAsrError(message.message, terminal_task=True)
                    raise RuntimeError(message.message)
                if not isinstance(
                    message,
                    StageProgress
                    | ModelProgress
                    | TranscriptionProgress
                    | CloudTaskSubmitted
                    | CloudSubmissionState,
                ):
                    raise RuntimeError("分析进程返回了无效消息")
                if isinstance(message, CloudTaskSubmitted | CloudSubmissionState):
                    on_progress(message)
                    send_operation = self._start_pipe_operation(
                        lambda: connection.send(True)
                    )
                elif stopping_at is None:
                    on_progress(message)
        except (EOFError, BrokenPipeError, OSError) as error:
            await self.close()
            if cancel_event.is_set():
                raise AnalysisCancelled("分析已停止") from error
            raise RuntimeError("分析进程意外退出，请重试") from error
        except BaseException:
            await self.close()
            raise

    def _start_pipe_operation(self, operation: Callable[[], object]) -> Future:
        """管道可能只传来半条消息，专属守护线程不能拖住默认线程池退出。"""
        future: Future = Future()

        def run() -> None:
            try:
                future.set_result(operation())
            except BaseException as error:
                future.set_exception(error)

        self._io_threads = {
            pending: thread
            for pending, thread in self._io_threads.items()
            if thread.is_alive()
        }
        thread = Thread(target=run, name="OpenVideo analysis IPC", daemon=True)
        self._io_threads[future] = thread
        thread.start()
        return future

    async def _ensure_started(self, cancel_event: Event) -> None:
        if self._stopping:
            await self.close()
        if self._process is not None and self._process.is_alive():
            return
        await self.close()
        connection, child_connection = self._context.Pipe()
        self._cancel_event = self._context.Event()
        process = self._context.Process(
            target=self._worker_entrypoint,
            args=(child_connection, self._cancel_event),
            name="OpenVideo analysis",
        )
        process.start()
        child_connection.close()
        self._process = process
        self._connection = connection
        deadline = monotonic() + WORKER_START_TIMEOUT_SECONDS
        try:
            ready_operation = self._start_pipe_operation(connection.recv)
            while not ready_operation.done():
                check_analysis_cancellation(cancel_event)
                if not process.is_alive() or monotonic() >= deadline:
                    raise RuntimeError("分析进程启动失败，请重试")
                await asyncio.sleep(WORKER_POLL_SECONDS)
            if not isinstance(ready_operation.result(), WorkerReady):
                raise RuntimeError("分析进程启动响应无效")
            self._session_ready = True
            if os.name == "nt":
                from openvideo.tools.process_tree import WindowsProcessJob

                self._windows_job = WindowsProcessJob(process.pid)
        except BaseException:
            await self.close()
            raise

    async def close(self) -> None:
        """系统检查失败也保留停止中，避免把未确认退出当成已停止。"""
        if not self._stopping:
            self._stopping = True
            if (
                self._process is not None
                and self._process.is_alive()
                and self._cancel_event is not None
            ):
                self._cancel_event.set()
        try:
            try:
                await self._stop_process_tree()
            finally:
                await self._close_pipe()
        except (OSError, subprocess.SubprocessError) as error:
            raise AnalysisWorkerNotStopped(
                "分析进程退出状态无法确认，暂时无法释放任务"
            ) from error
        if self._windows_job is not None:
            self._windows_job.close()
        if self._process is not None:
            self._process.close()
        self._process = None
        self._connection = None
        self._cancel_event = None
        self._windows_job = None
        self._session_ready = False
        self._stopping = False

    async def _close_pipe(self) -> None:
        """先中断系统读写，再释放句柄，避免旧线程误读被复用的描述符。"""
        connection = self._connection
        deadline = monotonic() + WORKER_IO_STOP_TIMEOUT_SECONDS
        while any(thread.is_alive() for thread in self._io_threads.values()):
            if connection is not None and not connection.closed:
                _interrupt_pipe_io(connection)
            if monotonic() >= deadline:
                raise AnalysisWorkerNotStopped("分析进程通信尚未退出，暂时无法释放任务")
            await asyncio.sleep(WORKER_POLL_SECONDS)
        self._io_threads.clear()
        if connection is not None:
            connection.close()

    async def _stop_process_tree(self) -> None:
        process = self._process
        if process is None:
            return
        if self._windows_job is not None:
            self._windows_job.terminate()
        elif os.name == "posix" and self._session_ready:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        elif process.is_alive():
            process.terminate()
        deadline = monotonic() + WORKER_TERMINATE_GRACE_SECONDS
        while process.is_alive() and monotonic() < deadline:
            await asyncio.sleep(WORKER_POLL_SECONDS)
        if os.name == "posix" and self._session_ready:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        elif process.is_alive():
            process.kill()
        deadline = monotonic() + WORKER_KILL_GRACE_SECONDS
        while process.is_alive() and monotonic() < deadline:
            await asyncio.sleep(WORKER_POLL_SECONDS)
        if process.is_alive():
            raise AnalysisWorkerNotStopped("分析进程尚未退出，暂时无法释放任务")
        if self._windows_job is not None:
            while self._windows_job.is_running() and monotonic() < deadline:
                await asyncio.sleep(WORKER_POLL_SECONDS)
            if self._windows_job.is_running():
                raise AnalysisWorkerNotStopped("分析子进程尚未退出，暂时无法释放任务")
        elif os.name == "posix" and self._session_ready:
            from openvideo.tools.process_tree import process_group_is_running

            while await asyncio.to_thread(process_group_is_running, process.pid):
                if monotonic() >= deadline:
                    raise AnalysisWorkerNotStopped(
                        "分析子进程尚未退出，暂时无法释放任务"
                    )
                await asyncio.sleep(WORKER_POLL_SECONDS)
        process.join(timeout=0)


def _interrupt_pipe_io(connection: Connection) -> None:
    if os.name == "posix":
        endpoint = socket.socket(fileno=connection.fileno())
        try:
            try:
                endpoint.shutdown(socket.SHUT_RDWR)
            except OSError as error:
                if error.errno != errno.ENOTCONN:
                    raise
        finally:
            endpoint.detach()
    elif os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CancelIoEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
        kernel.CancelIoEx.restype = wintypes.BOOL
        if not kernel.CancelIoEx(connection.fileno(), None):
            error = ctypes.get_last_error()
            if error != WINDOWS_IO_NOT_FOUND:
                raise ctypes.WinError(error)
