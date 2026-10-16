"""分析取消在工具边界协作退出，避免放弃线程后仍继续写入素材。"""

import subprocess
from threading import Event
from time import monotonic


PROCESS_POLL_SECONDS = 0.1
PROCESS_TERMINATION_SECONDS = 2


class AnalysisCancelled(Exception):
    """用户主动停止与运行失败分开处理，且不能触发模型自动回退。"""


def check_analysis_cancellation(cancel_event: Event | None) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise AnalysisCancelled("分析已停止")


def run_cancellable_process(
    command: list[str],
    cancel_event: Event,
    timeout_seconds: float,
) -> subprocess.CompletedProcess[str]:
    """停止媒体子进程并等待回收后才返回，让下一个分析安全使用工作目录。"""
    check_analysis_cancellation(cancel_event)
    process = subprocess.Popen(
        command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )
    deadline = monotonic() + timeout_seconds
    try:
        while True:
            check_analysis_cancellation(cancel_event)
            remaining = deadline - monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, timeout_seconds)
            try:
                stdout, stderr = process.communicate(
                    timeout=min(PROCESS_POLL_SECONDS, remaining)
                )
            except subprocess.TimeoutExpired:
                continue
            check_analysis_cancellation(cancel_event)
            return subprocess.CompletedProcess(
                command, process.returncode, stdout, stderr
            )
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.communicate(timeout=PROCESS_TERMINATION_SECONDS)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate(timeout=PROCESS_TERMINATION_SECONDS)
