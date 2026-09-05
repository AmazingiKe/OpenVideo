"""用低分辨率画面变化为课程时间轴提供辅助边界。"""

from __future__ import annotations

import re
import subprocess
from math import isfinite
from pathlib import Path

from openvideo.tools.media import resolve_tool


SCENE_CHANGE_THRESHOLD = 0.4
SCENE_SCAN_WIDTH = 320
SCENE_SCAN_TIMEOUT_SECONDS = 600
SCENE_SCORE_METADATA_KEY = "lavfi.scene_score"
NUMBER_PATTERN = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?"
SCENE_SCORE_PATTERN = re.compile(
    rf"pts_time:({NUMBER_PATTERN})[^\r\n]*\r?\n"
    rf"[^\r\n]*{re.escape(SCENE_SCORE_METADATA_KEY)}=({NUMBER_PATTERN})"
)
LOCAL_SCENE_THRESHOLDS = (0.42, 0.28, 0.16)
MINIMUM_CANDIDATE_COUNT = 3
MAXIMUM_CANDIDATE_COUNT = 7


def detect_scene_boundaries(
    media_path: Path,
    configured_ffmpeg_path: str | None,
    project_bin_dir: Path | None = None,
) -> list[float]:
    """镜头扫描失败时返回空列表，让音频时间轴仍可独立完成。"""
    scored_points = _scan_scene_scores(
        media_path,
        configured_ffmpeg_path,
        project_bin_dir,
        threshold=SCENE_CHANGE_THRESHOLD,
    )
    return [seconds for seconds, _score in scored_points]


def refine_scene_candidates(
    media_path: Path,
    start_seconds: float,
    end_seconds: float,
    target_count: int,
    configured_ffmpeg_path: str | None,
    project_bin_dir: Path | None = None,
) -> list[float]:
    """在证据窗口内用关键帧快速细分，避免为配图重复解码全部帧。"""

    if (
        not isfinite(start_seconds)
        or not isfinite(end_seconds)
        or start_seconds < 0
        or end_seconds <= start_seconds
    ):
        return []
    resolved_target = min(
        MAXIMUM_CANDIDATE_COUNT,
        max(MINIMUM_CANDIDATE_COUNT, target_count),
    )
    detected: list[float] = []
    # 场景分数由相同的相邻解码帧计算，低阈值扫描可供所有阈值复用。
    scored_points = _scan_scene_scores(
        media_path,
        configured_ffmpeg_path,
        project_bin_dir,
        threshold=min(LOCAL_SCENE_THRESHOLDS),
        start_seconds=start_seconds,
        end_seconds=end_seconds,
    )
    for threshold in LOCAL_SCENE_THRESHOLDS:
        detected = [seconds for seconds, score in scored_points if score > threshold]
        if len(detected) >= resolved_target - 1:
            break
    duration = end_seconds - start_seconds
    uniform = [
        start_seconds + duration * position / (resolved_target + 1)
        for position in range(1, resolved_target + 1)
    ]
    candidates = _deduplicate_times([*detected, *uniform], duration)
    if len(candidates) <= resolved_target:
        return candidates
    indexes = {
        round(index * (len(candidates) - 1) / (resolved_target - 1))
        for index in range(resolved_target)
    }
    return [candidates[index] for index in sorted(indexes)]


def _scan_scene_scores(
    media_path: Path,
    configured_ffmpeg_path: str | None,
    project_bin_dir: Path | None,
    *,
    threshold: float,
    start_seconds: float | None = None,
    end_seconds: float | None = None,
) -> list[tuple[float, float]]:
    ffmpeg_path = resolve_tool(configured_ffmpeg_path, "ffmpeg", project_bin_dir)
    if not media_path.is_file() or not ffmpeg_path:
        return []
    video_filter = (
        f"scale={SCENE_SCAN_WIDTH}:-1,select='gt(scene,{threshold})',"
        f"metadata=mode=print:key={SCENE_SCORE_METADATA_KEY}"
    )
    command = [
        ffmpeg_path,
        "-hide_banner",
        "-nostdin",
    ]
    if start_seconds is not None:
        command.extend(("-skip_frame", "nokey"))
        command.extend(("-ss", str(start_seconds)))
    command.extend(
        [
            "-i",
            str(media_path),
        ]
    )
    if start_seconds is not None and end_seconds is not None:
        command.extend(("-t", str(end_seconds - start_seconds)))
    command.extend(
        [
            "-an",
            "-vf",
            video_filter,
            "-f",
            "null",
            "-",
        ]
    )
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
    scored_points = [
        (float(seconds), float(score))
        for seconds, score in SCENE_SCORE_PATTERN.findall(result.stderr)
        if isfinite(float(seconds)) and isfinite(float(score))
    ]
    if start_seconds is not None and end_seconds is not None:
        duration_seconds = end_seconds - start_seconds
        scored_points = [
            (seconds, score)
            for seconds, score in scored_points
            if 0 <= seconds <= duration_seconds
        ]
    offset = start_seconds or 0.0
    return [(offset + seconds, score) for seconds, score in scored_points]


def _deduplicate_times(times: list[float], duration: float) -> list[float]:
    minimum_gap = max(0.2, duration / 40)
    selected: list[float] = []
    for seconds in sorted(times):
        if not selected or seconds - selected[-1] >= minimum_gap:
            selected.append(round(seconds, 3))
    return selected
