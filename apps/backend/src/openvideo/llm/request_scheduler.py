"""为在线模型请求提供前台优先的全局并发与冷却调度。"""

from __future__ import annotations

import asyncio
import heapq
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from enum import IntEnum
from itertools import count
from threading import Condition
from time import monotonic
from typing import AsyncIterator, Iterator


DEFAULT_MODEL_REQUEST_LIMIT = 4
BACKGROUND_CAPACITY_RESERVE = 1


class ModelRequestPriority(IntEnum):
    FOREGROUND = 0
    BACKGROUND = 10


@dataclass(order=True)
class _Waiter:
    priority: int
    sequence: int
    created_at: float = field(compare=False)
    cancelled: bool = field(default=False, compare=False)
    acquired: bool = field(default=False, compare=False)


class ModelRequestScheduler:
    """后台请求最多使用预留槽之外的容量，让新对话仍能进入。"""

    def __init__(self, limit: int = DEFAULT_MODEL_REQUEST_LIMIT) -> None:
        if limit < 1:
            raise ValueError("模型请求并发上限至少为 1")
        self._limit = limit
        self._active = 0
        self._condition = Condition()
        self._sequence = count()
        self._waiters: list[_Waiter] = []
        self._not_before = 0.0

    def set_limit(self, limit: int) -> None:
        if limit < 1:
            raise ValueError("模型请求并发上限至少为 1")
        with self._condition:
            self._limit = limit
            self._condition.notify_all()

    def defer(self, seconds: float) -> None:
        if seconds <= 0:
            return
        with self._condition:
            self._not_before = max(self._not_before, monotonic() + seconds)
            self._condition.notify_all()

    @contextmanager
    def slot(self, priority: ModelRequestPriority) -> Iterator[int]:
        waiter = self._enqueue(priority)
        try:
            wait_ms = self._wait(waiter)
            yield wait_ms
        finally:
            self._finish(waiter)

    @asynccontextmanager
    async def slot_async(self, priority: ModelRequestPriority) -> AsyncIterator[int]:
        waiter = self._enqueue(priority)
        try:
            wait_ms = await asyncio.to_thread(self._wait, waiter)
            yield wait_ms
        except asyncio.CancelledError:
            self._cancel(waiter)
            raise
        finally:
            self._finish(waiter)

    def _enqueue(self, priority: ModelRequestPriority) -> _Waiter:
        waiter = _Waiter(int(priority), next(self._sequence), monotonic())
        with self._condition:
            heapq.heappush(self._waiters, waiter)
            self._condition.notify_all()
        return waiter

    def _wait(self, waiter: _Waiter) -> int:
        with self._condition:
            while not waiter.cancelled:
                self._discard_cancelled()
                cooldown_seconds = self._not_before - monotonic()
                if (
                    cooldown_seconds <= 0
                    and self._waiters
                    and self._waiters[0] is waiter
                    and self._has_capacity(waiter)
                ):
                    heapq.heappop(self._waiters)
                    waiter.acquired = True
                    self._active += 1
                    self._condition.notify_all()
                    return round((monotonic() - waiter.created_at) * 1_000)
                self._condition.wait(
                    timeout=cooldown_seconds if cooldown_seconds > 0 else None
                )
        raise asyncio.CancelledError

    def _has_capacity(self, waiter: _Waiter) -> bool:
        if self._active >= self._limit:
            return False
        if waiter.priority == int(ModelRequestPriority.FOREGROUND):
            return True
        background_limit = max(1, self._limit - BACKGROUND_CAPACITY_RESERVE)
        return self._active < background_limit

    def _cancel(self, waiter: _Waiter) -> None:
        with self._condition:
            waiter.cancelled = True
            if waiter.acquired:
                waiter.acquired = False
                self._active -= 1
            self._condition.notify_all()

    def _finish(self, waiter: _Waiter) -> None:
        with self._condition:
            if waiter.acquired:
                waiter.acquired = False
                self._active -= 1
            else:
                waiter.cancelled = True
            self._condition.notify_all()

    def _discard_cancelled(self) -> None:
        while self._waiters and self._waiters[0].cancelled:
            heapq.heappop(self._waiters)


model_request_scheduler = ModelRequestScheduler()
_MODEL_REQUEST_SLOT_DEPTH: ContextVar[int] = ContextVar(
    "openvideo_model_request_slot_depth",
    default=0,
)


def configure_model_request_limit(limit: int) -> None:
    model_request_scheduler.set_limit(limit)


def defer_model_requests(seconds: float) -> None:
    model_request_scheduler.defer(seconds)


@contextmanager
def model_request_slot(priority: ModelRequestPriority) -> Iterator[int]:
    depth = _MODEL_REQUEST_SLOT_DEPTH.get()
    if depth > 0:
        yield 0
        return
    token = _MODEL_REQUEST_SLOT_DEPTH.set(depth + 1)
    try:
        with model_request_scheduler.slot(priority) as wait_ms:
            yield wait_ms
    finally:
        _MODEL_REQUEST_SLOT_DEPTH.reset(token)


@asynccontextmanager
async def model_request_slot_async(
    priority: ModelRequestPriority,
) -> AsyncIterator[int]:
    depth = _MODEL_REQUEST_SLOT_DEPTH.get()
    if depth > 0:
        yield 0
        return
    token = _MODEL_REQUEST_SLOT_DEPTH.set(depth + 1)
    try:
        async with model_request_scheduler.slot_async(priority) as wait_ms:
            yield wait_ms
    finally:
        _MODEL_REQUEST_SLOT_DEPTH.reset(token)
