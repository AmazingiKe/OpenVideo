import asyncio
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from time import monotonic, sleep

import pytest

from openvideo.llm.request_scheduler import (
    ModelRequestPriority,
    ModelRequestScheduler,
    configure_model_request_limit,
    model_request_slot,
)


def _wait_for_waiters(scheduler: ModelRequestScheduler, count: int) -> None:
    deadline = monotonic() + 1
    while monotonic() < deadline:
        with scheduler._condition:
            if len(scheduler._waiters) >= count:
                return
        sleep(0.005)
    raise AssertionError("调度请求未在预期时间内进入等待队列")


def test_foreground_request_overtakes_waiting_background_request():
    scheduler = ModelRequestScheduler(limit=1)
    acquisition_order: list[str] = []
    release = Event()

    def acquire(name: str, priority: ModelRequestPriority) -> None:
        with scheduler.slot(priority):
            acquisition_order.append(name)
            if name == "foreground":
                release.wait(timeout=1)

    executor = ThreadPoolExecutor(max_workers=2)
    try:
        with scheduler.slot(ModelRequestPriority.BACKGROUND):
            background = executor.submit(
                acquire,
                "background",
                ModelRequestPriority.BACKGROUND,
            )
            _wait_for_waiters(scheduler, 1)
            foreground = executor.submit(
                acquire,
                "foreground",
                ModelRequestPriority.FOREGROUND,
            )
            _wait_for_waiters(scheduler, 2)
        release.set()
        foreground.result(timeout=1)
        background.result(timeout=1)
    finally:
        release.set()
        executor.shutdown(wait=True)

    assert acquisition_order == ["foreground", "background"]


def test_background_leaves_one_capacity_slot_for_foreground():
    scheduler = ModelRequestScheduler(limit=2)
    background_acquired = Event()

    def acquire_background() -> None:
        with scheduler.slot(ModelRequestPriority.BACKGROUND):
            background_acquired.set()

    executor = ThreadPoolExecutor(max_workers=1)
    try:
        with scheduler.slot(ModelRequestPriority.BACKGROUND):
            background = executor.submit(acquire_background)
            _wait_for_waiters(scheduler, 1)
            with scheduler.slot(ModelRequestPriority.FOREGROUND):
                assert not background_acquired.is_set()
        background.result(timeout=1)
    finally:
        executor.shutdown(wait=True)

    assert background_acquired.is_set()


def test_global_cooldown_delays_next_request():
    scheduler = ModelRequestScheduler(limit=1)
    scheduler.defer(0.03)

    started_at = monotonic()
    with scheduler.slot(ModelRequestPriority.FOREGROUND):
        elapsed = monotonic() - started_at

    assert elapsed >= 0.02


def test_nested_model_request_slot_is_reentrant():
    configure_model_request_limit(1)
    try:
        with model_request_slot(ModelRequestPriority.BACKGROUND):
            with model_request_slot(ModelRequestPriority.FOREGROUND) as wait_ms:
                assert wait_ms == 0
    finally:
        configure_model_request_limit(4)


@pytest.mark.asyncio
async def test_cancelled_async_waiter_does_not_leak_capacity():
    scheduler = ModelRequestScheduler(limit=1)

    async def wait_for_slot() -> None:
        async with scheduler.slot_async(ModelRequestPriority.FOREGROUND):
            pass

    async with scheduler.slot_async(ModelRequestPriority.BACKGROUND):
        task = asyncio.create_task(wait_for_slot())
        await asyncio.to_thread(_wait_for_waiters, scheduler, 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    await asyncio.wait_for(wait_for_slot(), timeout=1)
