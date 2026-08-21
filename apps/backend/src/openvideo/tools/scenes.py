"""用低分辨率画面变化为课程时间轴提供辅助边界。"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

from openvideo.tools.media import resolve_tool


SCENE_CHANGE_THRESHOLD = 0.4
SCENE_SCAN_WIDTH = 320
SCENE_SCAN_TIMEOUT_SECONDS = 600
PTS_TIME_PATTERN = re.compile(r"pts_time:(\d+(?:\.\d+)?)")


def detect_scene_boundaries(
    media_path: Path,
    configured_ffmpeg_path: str | None,
    project_bin_dir: Path | None = None,
) -> list[float]:
    """镜头扫描失败时返回空列表，让音频时间轴仍可独立完成。"""
    ffmpeg_path = resolve_tool(configured_ffmpeg_path, "ffmpeg", project_bin_dir)
    if not media_path.is_file() or not ffmpeg_path:
        return []
    video_filter = (
        f"scale={SCENE_SCAN_WIDTH}:-1,"
        f"select='gt(scene,{SCENE_CHANGE_THRESHOLD})',showinfo"
    )
    command = [
        ffmpeg_path,
        "-hide_banner",
        "-i",
        str(media_path),
        "-an",
        "-vf",
        video_filter,
        "-f",
        "null",
        "-",
    ]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            check=False,
            text=True,
            timeout=SCENE_SCAN_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if result.returncode != 0:
        return []
    return [float(match) for match in PTS_TIME_PATTERN.findall(result.stderr)]
