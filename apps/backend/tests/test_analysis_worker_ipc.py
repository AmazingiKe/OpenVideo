import asyncio
import multiprocessing
import os
import struct
from threading import Event
from time import monotonic

import pytest

from openvideo.analysis_worker import (
    AnalysisProcessWorker,
    AnalysisWorkerNotStopped,
    TranscriptionRequest,
)
from openvideo.core.transcription_models import TranscriptionOptions
from openvideo.settings import Settings


BLOCKED_REQUEST_CHARACTERS = 8 * 1024 * 1024
INCOMPLETE_RESULT_BYTES = 1024 * 1024
TEST_TIMEOUT_SECONDS = 2


class UnconfirmedProcess:
    def __init__(self):
        self.closed = False
        self.alive = True

    def is_alive(self):
        return self.alive

    def close(self):
        self.closed = True


class UnconfirmedPipeWorker(AnalysisProcessWorker):
    def __init__(self, connection):
        super().__init__(stop_grace_seconds=0)
        self._connection = connection
        self._cancel_event = Event()
        self._process = UnconfirmedProcess()
        self.stop_confirmed = False

    async def _ensure_started(self, _cancel_event):
        return None

    async def _stop_process_tree(self):
        if not self.stop_confirmed:
            raise AnalysisWorkerNotStopped("系统尚未确认进程退出")


def transcription_request(tmp_path, *, context=""):
    return TranscriptionRequest(
        asset_id="01890f4c-7a2b-7cc2-98c4-dc0c0c07398f",
        media_path=tmp_path / "video.mp4",
        source_url="https://example.com/video",
        work_directory=tmp_path,
        settings=Settings(models_directory=str(tmp_path / "models")),
        options=TranscriptionOptions(),
        context=context,
        prepare_model=False,
        duration_seconds=1,
    )


async def wait_for_blocked_io(worker):
    deadline = monotonic() + TEST_TIMEOUT_SECONDS
    while True:
        if monotonic() >= deadline:
            pytest.fail("通信未进入阻塞状态")
        pending_operations = [
            pending for pending in worker._io_threads if not pending.done()
        ]
        await asyncio.sleep(0.05)
        if any(not pending.done() for pending in pending_operations):
            return list(worker._io_threads.values())


async def finish_stopped_task(task, peer, worker):
    peer.close()
    worker.stop_confirmed = True
    if not task.done():
        task.cancel()
    done, _ = await asyncio.wait({task}, timeout=TEST_TIMEOUT_SECONDS)
    assert task in done, "测试清理超时"
    if not task.cancelled():
        task.exception()
    await worker.close()


@pytest.mark.asyncio
async def test_blocked_send_does_not_hide_an_unconfirmed_process_exit(tmp_path):
    connection, peer = multiprocessing.Pipe()
    worker = UnconfirmedPipeWorker(connection)
    original_process = worker._process
    cancel_event = Event()
    task = asyncio.create_task(
        worker.execute(
            transcription_request(tmp_path, context="字" * BLOCKED_REQUEST_CHARACTERS),
            cancel_event,
            lambda _: None,
        )
    )
    try:
        threads = await wait_for_blocked_io(worker)
        assert any(not pending.done() for pending in worker._io_threads)
        cancel_event.set()
        done, _ = await asyncio.wait({task}, timeout=TEST_TIMEOUT_SECONDS)
        assert task in done, "停止失败不能继续等待阻塞的管道发送"
        with pytest.raises(AnalysisWorkerNotStopped, match="尚未确认"):
            task.result()
        assert worker._process is original_process
        assert not original_process.closed
        assert worker._stopping
        assert connection.closed
        assert all(thread.daemon and not thread.is_alive() for thread in threads)
        worker.stop_confirmed = True
        await worker.close()
        assert original_process.closed
        assert worker._process is None
    finally:
        await finish_stopped_task(task, peer, worker)


@pytest.mark.skipif(os.name != "posix", reason="半截字节流使用 POSIX duplex socket")
@pytest.mark.asyncio
async def test_partial_result_does_not_hide_an_unconfirmed_process_exit(tmp_path):
    connection, peer = multiprocessing.Pipe()
    worker = UnconfirmedPipeWorker(connection)
    original_process = worker._process
    cancel_event = Event()
    # poll 能看到消息头，但 recv 必须等待永远不会到达的剩余消息体。
    os.write(peer.fileno(), struct.pack("!i", INCOMPLETE_RESULT_BYTES) + b"partial")
    task = asyncio.create_task(
        worker.execute(transcription_request(tmp_path), cancel_event, lambda _: None)
    )
    try:
        threads = await wait_for_blocked_io(worker)
        cancel_event.set()
        done, _ = await asyncio.wait({task}, timeout=TEST_TIMEOUT_SECONDS)
        assert task in done, "停止失败不能继续等待未接收完整的消息"
        with pytest.raises(AnalysisWorkerNotStopped, match="尚未确认"):
            task.result()
        assert worker._process is original_process
        assert not original_process.closed
        assert connection.closed
        assert all(thread.daemon and not thread.is_alive() for thread in threads)
    finally:
        await finish_stopped_task(task, peer, worker)


@pytest.mark.asyncio
async def test_uninterruptible_io_keeps_ownership_without_blocking_cleanup():
    connection, peer = multiprocessing.Pipe()
    worker = UnconfirmedPipeWorker(connection)
    original_process = worker._process
    release = Event()
    worker._start_pipe_operation(release.wait)
    threads = list(worker._io_threads.values())
    task = asyncio.create_task(worker.close())
    try:
        done, _ = await asyncio.wait({task}, timeout=TEST_TIMEOUT_SECONDS)
        assert task in done, "无法中断的通信只能保留占用，不能无限等待"
        with pytest.raises(AnalysisWorkerNotStopped, match="通信尚未退出"):
            task.result()
        assert all(thread.daemon and thread.is_alive() for thread in threads)
        assert worker._process is original_process
        assert not original_process.closed
        assert not connection.closed
        assert worker._stopping
    finally:
        release.set()
        await finish_stopped_task(task, peer, worker)


@pytest.mark.parametrize("already_exited", [False, True])
@pytest.mark.asyncio
async def test_reaping_never_reuses_the_cancel_event_after_a_hard_stop(already_exited):
    connection, peer = multiprocessing.Pipe()
    worker = UnconfirmedPipeWorker(connection)
    worker._process.alive = not already_exited

    class DamagedAfterKillEvent:
        calls = 0

        def set(self):
            self.calls += 1
            if already_exited or self.calls > 1:
                raise AssertionError("硬杀后的共享锁不能再次访问")

    cancel_event = DamagedAfterKillEvent()
    worker._cancel_event = cancel_event
    try:
        for _ in range(2):
            with pytest.raises(AnalysisWorkerNotStopped):
                await worker.close()
        worker.stop_confirmed = True
        await worker.close()
        assert cancel_event.calls == (0 if already_exited else 1)
    finally:
        peer.close()
        worker.stop_confirmed = True
        await worker.close()
