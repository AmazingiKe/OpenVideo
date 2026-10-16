import asyncio
import subprocess
import sys
from types import SimpleNamespace
from threading import Event, Timer

import pytest

from openvideo import analysis_manager as analysis_manager_module
from openvideo.analysis_manager import AnalysisError, AnalysisManager
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

    monkeypatch.setattr(analysis_manager_module, "build_segments", blocked_analysis)
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
        await manager.close()
    assert manager.get(job.job_id).stage == AnalysisStage.CANCELLED
    assert library.load_segments(ASSET_ID) == [original]
    assert library.load_transcript(ASSET_ID) == transcript
    assert not manager.has_active_jobs()
    retry = manager.create_analysis(
        ASSET_ID, AnalysisMode.FULL, None, AnalysisStrategy(), True
    )
    assert retry.job_id != job.job_id


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

    monkeypatch.setattr(
        analysis_manager_module, "BailianTranscriber", cloud_transcriber
    )
    monkeypatch.setattr(analysis_manager_module, "transcribe_media", cloud_recognition)
    job = cloud_manager.create_transcription(ASSET_ID, options, False)
    cloud_manager.start(job.job_id)
    try:
        assert await asyncio.to_thread(entered.wait, 3)
        assert cloud_manager.cancel(job.job_id).stage == AnalysisStage.CANCELLING
    finally:
        finish.set()
        await cloud_manager.close()
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
