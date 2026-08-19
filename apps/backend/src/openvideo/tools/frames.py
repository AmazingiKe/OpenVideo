"""从视频按时间点抽取关键帧，供视觉模型分析画面。"""

from __future__ import annotations

import subprocess
from pathlib import Path

from openvideo.tools.media import resolve_tool


FRAME_QUALITY = 2
COMMAND_TIMEOUT_SECONDS = 120


class FrameExtractionError(RuntimeError):
    """无法从视频抽取关键帧时抛出。"""


def extract_frames(
    media_path: Path,
    time_points: list[float],
    output_directory: Path,
    configured_ffmpeg_path: str | None,
    project_bin_dir: Path | None = None,
) -> list[Path]:
    """对每个时间点抽一帧 JPEG，返回与输入一一对应的帧文件路径。"""
    if not media_path.is_file():
        raise FrameExtractionError("视频文件不存在，无法抽取关键帧")
    ffmpeg_path = resolve_tool(configured_ffmpeg_path, "ffmpeg", project_bin_dir)
    if not ffmpeg_path:
        raise FrameExtractionError("未找到 ffmpeg，无法抽取关键帧")

    output_directory.mkdir(parents=True, exist_ok=True)
    frame_paths: list[Path] = []
    for index, seconds in enumerate(time_points):
        frame_path = output_directory / f"frame_{index:03d}_{seconds:.1f}s.jpg"
        command = [
            ffmpeg_path,
            "-y",
            "-ss",
            str(seconds),
            "-i",
            str(media_path),
            "-frames:v",
            "1",
            "-q:v",
            str(FRAME_QUALITY),
            str(frame_path),
        ]
        result = subprocess.run(
            command,
            capture_output=True,
            check=False,
            text=True,
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
        if result.returncode != 0 or not frame_path.is_file():
            raise FrameExtractionError(f"第 {index + 1} 帧抽取失败")
        frame_paths.append(frame_path)
    return frame_paths
