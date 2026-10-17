import asyncio
import os
import signal
import subprocess
import sys
import time
from types import SimpleNamespace
from threading import Event

import pytest

from openvideo import analysis_worker
from openvideo.analysis_manager import AnalysisManager, AnalysisPrerequisiteError
from openvideo.analysis_worker import (
    AnalysisProcessWorker,
    StageProgress,
    TimelineRequest,
    TranscriptionRequest,
    WorkerReady,
    WorkerSuccess,
    CloudSubmissionState,
)
from openvideo.core.analysis_models import AnalysisMode, AnalysisStage, AnalysisStrategy
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import (
    MediaAsset,
    MediaAssetStatus,
    MediaSegment,
    SourcePlatform,
)
from openvideo.core.transcription_models import (
    Transcript,
    TranscriptSegment,
    TranscriptionOptions,
    TranscriptionEngine,
    BAILIAN_FUN_ASR_MODEL,
    TranscriptionStatus,
)
from openvideo.settings import Settings
from openvideo.tools.cancellation import AnalysisCancelled
from openvideo.tools.process_tree import process_group_is_running


ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"
SEGMENT_ID = "segment-019c0000000070008000000000000000"


def blocking_worker(connection, _cancel_event):
    if os.name == "posix":
        os.setsid()
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    connection.send(WorkerReady())
    request = connection.recv()
    if (
        isinstance(request, TimelineRequest)
        and request.media_path.name == "missing.mp4"
    ):
        connection.send(WorkerSuccess([]))
        connection.recv()
        return
    directory = (
        request.artifacts_directory
        if isinstance(request, TimelineRequest)
        else request.work_directory
    )
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "worker.pid").write_text(str(os.getpid()))
    child_code = """import os, signal, sys, time
from pathlib import Path
if os.name == 'posix':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
directory = Path(sys.argv[1])
(directory / 'child.pid').write_text(str(os.getpid()))
while True:
    (directory / 'heartbeat').write_text(str(time.monotonic()))
    time.sleep(0.02)
"""
    subprocess.Popen([sys.executable, "-c", child_code, str(directory)])
    while not (directory / "child.pid").exists():
        time.sleep(0.01)
    frame = directory / "frames" / "isolated" / "frame.jpg"
    frame.parent.mkdir(parents=True, exist_ok=True)
    frame.write_bytes(b"never publish a cancelled frame")
    connection.send(StageProgress(AnalysisStage.EXTRACTING_FRAMES, 80, "模型阻塞"))
    while True:
        time.sleep(60)


def transcription_request(tmp_path):
    return TranscriptionRequest(
        asset_id=ASSET_ID,
        media_path=tmp_path / "video.mp4",
        source_url="https://example.com/video",
        work_directory=tmp_path,
        settings=Settings(models_directory=str(tmp_path / "models")),
        options=TranscriptionOptions(),
        context="",
        prepare_model=False,
        duration_seconds=1,
    )


@pytest.mark.asyncio
async def test_real_worker_cancel_reaps_blocked_model_and_its_child_before_retry(
    tmp_path,
):
    worker = AnalysisProcessWorker(
        stop_grace_seconds=0.1, worker_entrypoint=blocking_worker
    )
    cancel_event = Event()
    ready = asyncio.Event()
    task = asyncio.create_task(
        worker.execute(
            transcription_request(tmp_path), cancel_event, lambda _: ready.set()
        )
    )
    try:
        await asyncio.wait_for(ready.wait(), timeout=20)
        process_id = int((tmp_path / "worker.pid").read_text())
        started = time.monotonic()
        cancel_event.set()
        with pytest.raises(AnalysisCancelled):
            await asyncio.wait_for(task, timeout=5)
        assert time.monotonic() - started < 5
        if os.name == "posix":
            assert not process_group_is_running(process_id)
            with pytest.raises(ProcessLookupError):
                os.kill(process_id, 0)
        heartbeat = (tmp_path / "heartbeat").read_text()
        await asyncio.sleep(0.15)
        assert (tmp_path / "heartbeat").read_text() == heartbeat
        # 强杀过的管道和进程不会再被后续任务使用。
        await worker.execute(timeline_request(tmp_path), Event(), lambda _: None)
        assert worker._process.pid != process_id
    finally:
        if not task.done():
            cancel_event.set()
            await asyncio.gather(task, return_exceptions=True)
        await worker.close()


def timeline_request(tmp_path):
    return TimelineRequest(
        transcript=Transcript(
            asset_id=ASSET_ID,
            segments=[
                TranscriptSegment(start_seconds=0, end_seconds=1, text="已有字幕")
            ],
        ),
        media_path=tmp_path / "missing.mp4",
        asset_id=ASSET_ID,
        artifacts_directory=tmp_path / "staged",
        duration_seconds=1,
        settings=Settings(models_directory=str(tmp_path / "models")),
        markers=[],
        strategy=AnalysisStrategy(),
        model=None,
    )


def blocked_cloud_submission_worker(connection, _cancel_event):
    if os.name == "posix":
        os.setsid()
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    connection.send(WorkerReady())
    request = connection.recv()
    connection.send(CloudSubmissionState(True))
    assert connection.recv() is True
    request.settings.models_root_directory.mkdir(parents=True, exist_ok=True)
    with (request.settings.models_root_directory / "cloud-posts").open("a") as counter:
        counter.write("POST\n")
    connection.send(StageProgress(AnalysisStage.TRANSCRIBING, 10, "云提交阻塞"))
    while True:
        time.sleep(60)


@pytest.mark.asyncio
async def test_hard_stop_during_cloud_submission_blocks_repost_and_preserves_old_subtitles(
    tmp_path,
):
    library_path = tmp_path / "library"
    library_path.mkdir()
    library = MediaLibrary.initialize_directory(library_path)
    directory = library.asset_directory(ASSET_ID)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "playback.mp4").write_bytes(b"video")
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="https://example.com/video",
            source_platform=SourcePlatform.BILIBILI,
            title="视频",
            status=MediaAssetStatus.READY,
            playback_path="playback.mp4",
            duration_seconds=1,
        )
    )
    original = timeline_request(tmp_path).transcript
    library.save_transcript(original)
    options = TranscriptionOptions(
        engine=TranscriptionEngine.BAILIAN, model=BAILIAN_FUN_ASR_MODEL
    )
    worker = AnalysisProcessWorker(
        stop_grace_seconds=0.1, worker_entrypoint=blocked_cloud_submission_worker
    )
    settings = Settings(
        library_path=library.library_path, models_directory=str(tmp_path / "models")
    )
    manager = AnalysisManager(
        library,
        settings,
        worker=worker,
        bailian_credential_store=SimpleNamespace(require_api_key=lambda _: "test-key"),
    )
    job = manager.create_transcription(ASSET_ID, options, True)
    manager.start(job.job_id)
    try:
        async with asyncio.timeout(20):
            while manager.get(job.job_id).message != "云提交阻塞":
                await asyncio.sleep(0.05)
        manager.cancel(job.job_id)
        await asyncio.wait_for(manager.close(), timeout=5)
        metadata = library.load_transcription_metadata(ASSET_ID)
        assert metadata.status == TranscriptionStatus.CANCELLED
        assert metadata.cloud_submission_uncertain is True
        assert metadata.cloud_task_id is None
        with pytest.raises(AnalysisPrerequisiteError, match="资料库正在关闭"):
            manager.create_transcription(ASSET_ID, options, True)
        manager = AnalysisManager(
            library, settings,
            bailian_credential_store=SimpleNamespace(require_api_key=lambda _: "test-key"),
        )
        manager.restore()
        for _ in range(2):
            with pytest.raises(AnalysisPrerequisiteError, match="云端提交结果未确认"):
                manager.create_transcription(ASSET_ID, options, True)
        assert (settings.models_root_directory / "cloud-posts").read_text() == "POST\n"
        assert library.load_transcript(ASSET_ID) == original
    finally:
        await manager.close()
        library.close()


@pytest.mark.asyncio
async def test_production_worker_returns_timeline_and_reuses_its_process(tmp_path):
    worker = AnalysisProcessWorker()
    progress = []
    try:
        first = await worker.execute(
            timeline_request(tmp_path), Event(), progress.append
        )
        process_id = worker._process.pid
        second = await worker.execute(
            timeline_request(tmp_path), Event(), progress.append
        )
        assert worker._process.pid == process_id
        assert first[0].transcript_text == second[0].transcript_text == "已有字幕"
        assert progress
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_model_deadline_reaps_blocked_process_without_a_stop_request(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(analysis_worker, "TRANSCRIPTION_DEADLINE_SECONDS", 0.3)
    worker = AnalysisProcessWorker(worker_entrypoint=blocking_worker)
    try:
        with pytest.raises(RuntimeError, match="超过执行时限"):
            await asyncio.wait_for(
                worker.execute(
                    transcription_request(tmp_path), Event(), lambda _: None
                ),
                timeout=20,
            )
        assert worker._process is None
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_shutdown_stops_real_blocked_analysis_and_never_publishes_staged_frames(
    tmp_path,
):
    library_path = tmp_path / "library"
    library_path.mkdir()
    library = MediaLibrary.initialize_directory(library_path)
    directory = library.asset_directory(ASSET_ID)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "playback.mp4").write_bytes(b"video")
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="https://example.com/video",
            source_platform=SourcePlatform.BILIBILI,
            title="视频",
            status=MediaAssetStatus.READY,
            playback_path="playback.mp4",
            duration_seconds=1,
        )
    )
    request = timeline_request(tmp_path)
    library.save_transcript(request.transcript)
    original = MediaSegment(
        segment_id=SEGMENT_ID,
        asset_id=ASSET_ID,
        start_seconds=0,
        end_seconds=1,
        title="保留章节",
    )
    library.save_segments(ASSET_ID, [original])
    worker = AnalysisProcessWorker(
        stop_grace_seconds=0.1, worker_entrypoint=blocking_worker
    )
    manager = AnalysisManager(
        library, Settings(library_path=library.library_path), worker=worker
    )
    job = manager.create_analysis(
        ASSET_ID, AnalysisMode.FULL, None, AnalysisStrategy(), True
    )
    manager.start(job.job_id)
    try:
        async with asyncio.timeout(20):
            while manager.get(job.job_id).message != "模型阻塞":
                await asyncio.sleep(0.05)
        work_directory = library.temporary_directory(job.job_id)
        assert (
            work_directory / "artifacts" / "frames" / "isolated" / "frame.jpg"
        ).is_file()
        await asyncio.wait_for(manager.close(), timeout=5)
        assert manager.get(job.job_id).stage == AnalysisStage.CANCELLED
        assert not manager.has_active_jobs()
        assert library.load_segments(ASSET_ID) == [original]
        assert not (
            library.artifacts_directory(ASSET_ID) / "frames" / "isolated"
        ).exists()
        assert not work_directory.exists()
    finally:
        await manager.close()
        library.close()
