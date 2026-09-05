"""从视频按时间点抽取关键帧，供视觉模型分析画面。"""

from __future__ import annotations

import subprocess
from math import isfinite
from pathlib import Path
from threading import Event
from time import monotonic

from openvideo.tools.media import resolve_tool


FRAME_QUALITY = 2
COMMAND_TIMEOUT_SECONDS = 120
# 多输入共享进程启动成本，同时限制并行解码器的内存占用。
FRAME_EXTRACTION_BATCH_SIZE = 4
PROCESS_POLL_SECONDS = 0.05
PROCESS_TERMINATION_SECONDS = 2


class FrameExtractionError(RuntimeError):
    """无法从视频抽取关键帧时抛出。"""


def extract_frames(
    media_path: Path,
    time_points: list[float],
    output_directory: Path,
    configured_ffmpeg_path: str | None,
    project_bin_dir: Path | None = None,
    cancel_event: Event | None = None,
) -> list[Path]:
    """按独立精确寻址批量抽帧，保留调用方的时间顺序与原始画面质量。"""
    if not time_points:
        return []
    if any(not isfinite(seconds) or seconds < 0 for seconds in time_points):
        raise FrameExtractionError("关键帧时间点必须是非负有限数值")
    if not media_path.is_file():
        raise FrameExtractionError("视频文件不存在，无法抽取关键帧")
    ffmpeg_path = resolve_tool(configured_ffmpeg_path, "ffmpeg", project_bin_dir)
    if not ffmpeg_path:
        raise FrameExtractionError("未找到 ffmpeg，无法抽取关键帧")

    output_directory.mkdir(parents=True, exist_ok=True)
    frame_paths = [
        output_directory / f"frame_{index:03d}_{seconds:.3f}s.jpg"
        for index, seconds in enumerate(time_points)
    ]
    for batch_start in range(0, len(time_points), FRAME_EXTRACTION_BATCH_SIZE):
        if cancel_event is not None and cancel_event.is_set():
            raise FrameExtractionError("关键帧抽取已取消")
        batch_times = time_points[
            batch_start : batch_start + FRAME_EXTRACTION_BATCH_SIZE
        ]
        batch_paths = frame_paths[
            batch_start : batch_start + FRAME_EXTRACTION_BATCH_SIZE
        ]
        command = [
            ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
        ]
        for seconds in batch_times:
            command.extend(["-ss", str(seconds), "-i", str(media_path)])
        for input_index, frame_path in enumerate(batch_paths):
            command.extend(
                [
                    "-map",
                    f"{input_index}:v:0",
                    "-frames:v",
                    "1",
                    "-q:v",
                    str(FRAME_QUALITY),
                    str(frame_path),
                ]
            )
        try:
            result = (
                _run_cancellable(command, cancel_event)
                if cancel_event is not None
                else subprocess.run(
                    command,
                    capture_output=True,
                    check=False,
                    text=True,
                    timeout=COMMAND_TIMEOUT_SECONDS,
                )
            )
        except subprocess.TimeoutExpired as error:
            raise FrameExtractionError("关键帧抽取超时") from error
        missing_frame = next(
            (
                batch_start + index + 1
                for index, path in enumerate(batch_paths)
                if not path.is_file() or path.stat().st_size == 0
            ),
            None,
        )
        if result.returncode != 0 or missing_frame is not None:
            raise FrameExtractionError(
                f"第 {missing_frame or batch_start + 1} 帧抽取失败"
            )
    return frame_paths


def _run_cancellable(
    command: list[str],
    cancel_event: Event,
) -> subprocess.CompletedProcess[str]:
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    started_at = monotonic()
    try:
        while process.poll() is None:
            if cancel_event.wait(PROCESS_POLL_SECONDS):
                process.terminate()
                try:
                    process.wait(timeout=PROCESS_TERMINATION_SECONDS)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=PROCESS_TERMINATION_SECONDS)
                raise FrameExtractionError("关键帧抽取已取消")
            if monotonic() - started_at >= COMMAND_TIMEOUT_SECONDS:
                process.kill()
                process.wait(timeout=PROCESS_TERMINATION_SECONDS)
                raise FrameExtractionError("关键帧抽取超时")
            try:
                stdout, stderr = process.communicate(timeout=PROCESS_POLL_SECONDS)
            except subprocess.TimeoutExpired:
                continue
            return subprocess.CompletedProcess(
                command, process.returncode, stdout, stderr
            )
        stdout, stderr = process.communicate()
        return subprocess.CompletedProcess(
            command,
            process.returncode,
            stdout,
            stderr,
        )
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=PROCESS_TERMINATION_SECONDS)
