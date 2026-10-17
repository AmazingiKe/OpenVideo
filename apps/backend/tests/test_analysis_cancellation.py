import asyncio
import subprocess
import sys
from types import SimpleNamespace
from threading import Event, Timer

import pytest

from openvideo import analysis_worker as analysis_worker_module
from openvideo.analysis_manager import (
    AnalysisError,
    AnalysisManager,
    AnalysisPrerequisiteError,
)
from openvideo.analysis_worker import AnalysisWorkerNotStopped
from openvideo.core.analysis_models import AnalysisMode, AnalysisStage, AnalysisStrategy
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import (
    MediaAsset,
    MediaAssetStatus,
    MediaSegment,
    SourcePlatform,
)
from openvideo.core.transcription_models import (
    BAILIAN_FUN_ASR_MODEL,
    Transcript,
    TranscriptSegment,
    TranscriptionStatus,
    TranscriptionEngine,
    TranscriptionOptions,
)
from openvideo.settings import Settings
from openvideo.tools.cancellation import AnalysisCancelled, run_cancellable_process
from openvideo.tools.transcribe import FasterWhisperTranscriber
from openvideo.tools import chapters
from openvideo.tools.transcribe import TranscriptionResult


ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"
SECOND_ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c073990"
SEGMENT_ID = "segment-019c0000000070008000000000000000"


@pytest.fixture
def manager(tmp_path):
    library = MediaLibrary.initialize_directory(tmp_path)
    for asset_id in (ASSET_ID, SECOND_ASSET_ID):
        directory = library.asset_directory(asset_id)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "playback.mp4").write_bytes(b"video")
        library.save(
            MediaAsset(
                asset_id=asset_id,
                source_url="https://example.com/video",
                source_platform=SourcePlatform.BILIBILI,
                title="测试视频",
                status=MediaAssetStatus.READY,
                playback_path="playback.mp4",
                duration_seconds=30,
            )
        )
    settings = Settings(
        library_path=library.library_path, models_directory=str(tmp_path / "models")
    )
    analysis_manager = AnalysisManager(library, settings)
    yield analysis_manager
    library.close()


def test_cancel_pending_job_is_terminal_idempotent_and_survives_restart(manager):
    job = manager.create_initialization(ASSET_ID)
    cancelled = manager.cancel(job.job_id)

    assert cancelled.stage == AnalysisStage.CANCELLED
    assert manager.cancel(job.job_id) == cancelled
    assert not manager.has_active_jobs()
    assert (
        manager.library.load_transcription_metadata(ASSET_ID).status
        == TranscriptionStatus.CANCELLED
    )
    recovered = AnalysisManager(manager.library, manager.settings)
    recovered.restore()
    assert recovered.get(job.job_id).stage == AnalysisStage.CANCELLED
    retry = recovered.create_initialization(ASSET_ID)
    assert retry.job_id != job.job_id
    assert retry.stage == AnalysisStage.PENDING


def test_cancel_unknown_job_is_rejected(manager):
    with pytest.raises(AnalysisError, match="分析任务不存在"):
        manager.cancel("job-missing")


@pytest.mark.asyncio
async def test_closing_rejects_new_jobs_before_worker_cleanup_finishes(manager):
    class ClosingWorker:
        def __init__(self):
            self.close_entered = asyncio.Event()
            self.allow_close = asyncio.Event()
            self.execute_calls = 0

        async def execute(self, *_args):
            self.execute_calls += 1
            return []

        async def close(self):
            self.close_entered.set()
            await self.allow_close.wait()

    transcript = Transcript(
        asset_id=ASSET_ID,
        segments=[TranscriptSegment(start_seconds=0, end_seconds=1, text="保留字幕")],
    )
    manager.library.save_transcript(transcript)
    worker = ClosingWorker()
    closing_manager = AnalysisManager(manager.library, manager.settings, worker=worker)
    queued = closing_manager.create_analysis(
        ASSET_ID, AnalysisMode.FULL, None, AnalysisStrategy(), True
    )
    closing = asyncio.create_task(closing_manager.close())
    try:
        await asyncio.wait_for(worker.close_entered.wait(), timeout=1)
        operations = [
            lambda: closing_manager.create_analysis(
                ASSET_ID, AnalysisMode.FULL, None, AnalysisStrategy(), True
            ),
            lambda: closing_manager.create_transcription(
                ASSET_ID, TranscriptionOptions(), True
            ),
            lambda: closing_manager.create_initialization(ASSET_ID),
            lambda: closing_manager.initialize_asset(ASSET_ID),
            lambda: closing_manager.create_chapters(ASSET_ID),
            lambda: closing_manager.start(queued.job_id),
        ]
        for operation in operations:
            with pytest.raises(AnalysisPrerequisiteError, match="资料库正在关闭"):
                operation()
        assert len(manager.library.load_analysis_jobs()) == 1
        assert manager.library.load_transcript(ASSET_ID) == transcript
        assert not closing_manager.has_active_jobs()
        assert not closing_manager._tasks
        assert worker.execute_calls == 0
        worker.allow_close.set()
        await asyncio.wait_for(closing, timeout=1)
        for operation in operations:
            with pytest.raises(AnalysisPrerequisiteError, match="资料库正在关闭"):
                operation()
    finally:
        worker.allow_close.set()
        await asyncio.wait_for(closing, timeout=1)


@pytest.mark.asyncio
async def test_unconfirmed_process_exit_keeps_the_asset_and_stopping_state(manager):
    class UnconfirmedWorker:
        async def execute(self, *_args):
            raise AnalysisWorkerNotStopped("系统未确认退出")

        async def close(self):
            raise AnalysisWorkerNotStopped("系统未确认退出")

    blocked = AnalysisManager(
        manager.library, manager.settings, worker=UnconfirmedWorker()
    )
    job = blocked.create_initialization(ASSET_ID)
    await blocked._run(job.job_id)

    current = blocked.get(job.job_id)
    assert current.stage == AnalysisStage.CANCELLING
    assert current.error_message == "系统未确认退出"
    assert blocked.has_active_jobs()
    assert blocked.create_initialization(ASSET_ID).job_id == job.job_id
    assert job.job_id in blocked._running_job_ids


@pytest.mark.asyncio
async def test_process_exit_is_rechecked_and_releases_the_old_job_automatically(
    manager,
):
    class RecoveringWorker:
        close_calls = 0

        async def execute(self, *_args):
            raise AnalysisWorkerNotStopped("首次退出未确认")

        async def close(self):
            self.close_calls += 1
            if self.close_calls == 1:
                raise AnalysisWorkerNotStopped("退出仍未确认")

    worker = RecoveringWorker()
    blocked = AnalysisManager(manager.library, manager.settings, worker=worker)
    job = blocked.create_initialization(ASSET_ID)
    await blocked._run(job.job_id)

    assert worker.close_calls == 2
    assert blocked.get(job.job_id).stage == AnalysisStage.CANCELLED
    assert job.job_id not in blocked._running_job_ids
    assert job.job_id not in blocked._cancel_events
    assert not blocked.has_active_jobs()
    assert blocked.create_initialization(ASSET_ID).job_id != job.job_id


@pytest.mark.asyncio
async def test_repeated_stop_reaps_late_exit_without_restarting_old_analysis(
    manager, monkeypatch
):
    class LateExitWorker:
        allow_exit = False
        execute_calls = 0

        async def execute(self, request, *_args):
            self.execute_calls += 1
            if self.allow_exit:
                return TranscriptionResult(
                    Transcript(asset_id=request.asset_id), "test"
                )
            raise AnalysisWorkerNotStopped("退出未确认")

        async def close(self):
            if not self.allow_exit:
                raise AnalysisWorkerNotStopped("退出未确认")

    monkeypatch.setattr(
        "openvideo.analysis_manager.require_transcription_model_installed",
        lambda *_: None,
    )
    worker = LateExitWorker()
    blocked = AnalysisManager(manager.library, manager.settings, worker=worker)
    manager.library.save_transcript(Transcript(asset_id=ASSET_ID))
    options = TranscriptionOptions()
    job = blocked.create_transcription(ASSET_ID, options, True)
    blocked.start(job.job_id)
    await asyncio.gather(*list(blocked._tasks.values()))
    await asyncio.sleep(0)
    assert job.job_id not in blocked._tasks
    assert job.job_id in blocked._cancel_events
    assert blocked.get(job.job_id).stage == AnalysisStage.CANCELLING

    returned = [
        blocked.create_initialization(ASSET_ID),
        blocked.create_analysis(
            ASSET_ID, AnalysisMode.FULL, None, AnalysisStrategy(), True
        ),
        blocked.create_transcription(ASSET_ID, options, True),
    ]
    for existing in returned:
        assert existing.job_id == job.job_id
        blocked.start(existing.job_id)
    await asyncio.sleep(0)
    assert worker.execute_calls == 1
    assert not blocked._worker_available.is_set()

    queued = blocked.create_transcription(SECOND_ASSET_ID, options, True)
    blocked.start(queued.job_id)
    await asyncio.sleep(0)
    assert worker.execute_calls == 1
    assert blocked.get(queued.job_id).stage == AnalysisStage.PENDING

    worker.allow_exit = True
    await asyncio.to_thread(blocked.cancel, job.job_id)
    async with asyncio.timeout(3):
        while blocked.get(job.job_id).stage != AnalysisStage.CANCELLED:
            await asyncio.sleep(0.01)
    assert job.job_id not in blocked._running_job_ids
    assert job.job_id not in blocked._cancel_events
    assert blocked._worker_available.is_set()
    async with asyncio.timeout(3):
        while blocked.get(queued.job_id).stage != AnalysisStage.COMPLETE:
            await asyncio.sleep(0.01)
    await asyncio.gather(*list(blocked._tasks.values()))
    assert not blocked.has_active_jobs()
    assert worker.execute_calls == 2
    assert blocked.create_transcription(ASSET_ID, options, True).job_id != job.job_id


def test_cancel_does_not_change_completed_job(manager):
    job = manager.create_initialization(ASSET_ID)
    manager._update_job(job.job_id, AnalysisStage.COMPLETE, 100, "已完成")

    assert manager.cancel(job.job_id).stage == AnalysisStage.COMPLETE
    assert manager.get(job.job_id).message == "已完成"


@pytest.mark.asyncio
async def test_running_cancel_waits_for_worker_and_does_not_publish_old_results(
    manager, monkeypatch
):
    library = manager.library
    transcript = Transcript(
        asset_id=ASSET_ID,
        segments=[TranscriptSegment(start_seconds=0, end_seconds=10, text="保留字幕")],
    )
    original = MediaSegment(
        segment_id=SEGMENT_ID,
        asset_id=ASSET_ID,
        start_seconds=0,
        end_seconds=10,
        title="原有章节",
    )
    library.save_transcript(transcript)
    library.save_segments(ASSET_ID, [original])
    library.save_transcript(transcript.model_copy(update={"asset_id": SECOND_ASSET_ID}))
    entered = Event()
    finish = Event()
    calls = []

    def blocked_analysis(*args):
        calls.append(args[2])
        entered.set()
        assert finish.wait(timeout=5)
        return [original.model_copy(update={"title": "不该覆盖的结果"})]

    monkeypatch.setattr(analysis_worker_module, "build_segments", blocked_analysis)
    job = manager.create_analysis(
        ASSET_ID, AnalysisMode.FULL, None, AnalysisStrategy(), True
    )
    manager.start(job.job_id)
    try:
        assert await asyncio.to_thread(entered.wait, 3)
        assert manager.cancel(job.job_id).stage == AnalysisStage.CANCELLING
        assert manager.has_active_jobs()
        assert (
            manager.create_analysis(
                ASSET_ID, AnalysisMode.FULL, None, AnalysisStrategy(), True
            ).job_id
            == job.job_id
        )
        queued = manager.create_analysis(
            SECOND_ASSET_ID, AnalysisMode.FULL, None, AnalysisStrategy(), True
        )
        manager.start(queued.job_id)
        await asyncio.sleep(0)
        assert manager.cancel(queued.job_id).stage == AnalysisStage.CANCELLED
        assert calls == [ASSET_ID]
    finally:
        finish.set()
        await asyncio.gather(*list(manager._tasks.values()), return_exceptions=True)
    assert manager.get(job.job_id).stage == AnalysisStage.CANCELLED
    assert library.load_segments(ASSET_ID) == [original]
    assert library.load_transcript(ASSET_ID) == transcript
    assert not manager.has_active_jobs()
    retry = manager.create_analysis(
        ASSET_ID, AnalysisMode.FULL, None, AnalysisStrategy(), True
    )
    assert retry.job_id != job.job_id
    await manager.close()


def test_restart_finishes_requested_cancellation_without_restarting_worker(manager):
    job = manager.create_initialization(ASSET_ID)
    manager.library.save_analysis_job(
        job.model_copy(update={"stage": AnalysisStage.CANCELLING})
    )

    recovered = AnalysisManager(manager.library, manager.settings)
    recovered.restore()

    assert recovered.get(job.job_id).stage == AnalysisStage.CANCELLED
    assert (
        recovered.library.load_transcription_metadata(ASSET_ID).status
        == TranscriptionStatus.CANCELLED
    )
    assert not recovered.has_active_jobs()


def test_cancelling_media_command_reaps_the_process(monkeypatch):
    created = []
    create_process = subprocess.Popen

    def capture_process(*args, **kwargs):
        process = create_process(*args, **kwargs)
        created.append(process)
        return process

    monkeypatch.setattr(subprocess, "Popen", capture_process)
    cancel_event = Event()
    timer = Timer(0.2, cancel_event.set)
    timer.start()
    try:
        with pytest.raises(AnalysisCancelled):
            run_cancellable_process(
                [sys.executable, "-c", "import time; time.sleep(30)"], cancel_event, 10
            )
    finally:
        timer.join()
    assert len(created) == 1
    assert created[0].poll() is not None


def test_cancelled_whisper_does_not_retry_on_another_device(tmp_path):
    def stop():
        raise AnalysisCancelled("分析已停止")

    transcriber = FasterWhisperTranscriber(device="auto", cancellation_check=stop)
    with pytest.raises(AnalysisCancelled):
        transcriber.transcribe(tmp_path / "audio.wav", ASSET_ID)
    assert transcriber.device == "auto"


@pytest.mark.asyncio
async def test_cancelled_cloud_transcription_preserves_task_for_retry(
    manager, monkeypatch
):
    cloud_manager = AnalysisManager(
        manager.library,
        manager.settings,
        bailian_credential_store=SimpleNamespace(
            require_api_key=lambda _region: "test-key"
        ),
    )
    options = TranscriptionOptions(
        engine=TranscriptionEngine.BAILIAN, model=BAILIAN_FUN_ASR_MODEL
    )
    entered = Event()
    finish = Event()
    captured = {}

    def cloud_transcriber(*_args, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace()

    def cloud_recognition(*args, **_kwargs):
        args[-1]()
        captured["on_task_submitted"]("cloud-task-to-resume")
        entered.set()
        assert finish.wait(timeout=5)
        captured["cancellation_check"]()
        return TranscriptionResult(Transcript(asset_id=ASSET_ID), "bailian/fun-asr")

    monkeypatch.setattr(analysis_worker_module, "BailianTranscriber", cloud_transcriber)
    monkeypatch.setattr(analysis_worker_module, "transcribe_media", cloud_recognition)
    job = cloud_manager.create_transcription(ASSET_ID, options, False)
    cloud_manager.start(job.job_id)
    try:
        assert await asyncio.to_thread(entered.wait, 3)
        assert cloud_manager.cancel(job.job_id).stage == AnalysisStage.CANCELLING
    finally:
        finish.set()
        await asyncio.gather(
            *list(cloud_manager._tasks.values()), return_exceptions=True
        )
    metadata = manager.library.load_transcription_metadata(ASSET_ID)
    assert metadata.status == TranscriptionStatus.CANCELLED
    assert metadata.cloud_task_id == "cloud-task-to-resume"
    assert manager.library.load_transcript(ASSET_ID) is None
    retry = cloud_manager.create_transcription(ASSET_ID, options, False)
    assert retry.job_id != job.job_id
    assert (
        manager.library.load_transcription_metadata(ASSET_ID).cloud_task_id
        == "cloud-task-to-resume"
    )
    await cloud_manager.close()


def test_cancelled_chapter_summary_does_not_start_followup_request(monkeypatch):
    cancel_event = Event()
    calls = []

    def complete(*_args, **_kwargs):
        calls.append(True)
        cancel_event.set()
        return '{"summary":"已完成的一步"}'

    monkeypatch.setattr(chapters, "complete_text", complete)
    with pytest.raises(AnalysisCancelled):
        chapters.summarize_chapter(
            SimpleNamespace(), "标题", "字幕", None, None, cancel_event=cancel_event
        )
    assert calls == [True]


@pytest.fixture(autouse=True)
def inject_analysis_worker(monkeypatch):
    from openvideo import analysis_manager
    from analysis_worker_test_support import InlineAnalysisWorker

    monkeypatch.setattr(analysis_manager, "AnalysisProcessWorker", InlineAnalysisWorker)


def test_progress_precision_is_reset_between_measured_and_cloud_stages(manager):
    job = manager.create_initialization(ASSET_ID)
    assert job.started_at is None
    manager._update_job(
        job.job_id, AnalysisStage.TRANSCRIBING, 20, "本地转写", progress_known=True
    )
    assert manager.get(job.job_id).progress_known
    manager._update_job(job.job_id, AnalysisStage.TRANSCRIBING, 20, "百炼排队中")
    assert not manager.get(job.job_id).progress_known
    restored = manager.library.load_analysis_jobs()
    assert not next(
        item for item in restored if item.job_id == job.job_id
    ).progress_known
    manager.cancel(job.job_id)
