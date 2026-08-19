import subprocess
from pathlib import Path

from openvideo.core.thumbnails import (
    ThumbnailStoryboard,
    build_thumbnail_storyboard,
    storyboard_rows,
)
from openvideo.tools.media import resolve_tool


SPRITE_GENERATION_TIMEOUT_SECONDS = 600
SPRITE_JPEG_QUALITY = "4"


def generate_thumbnail_sprite(
    video_path: Path,
    asset_directory: Path,
    duration_seconds: float | None,
    configured_ffmpeg_path: str | None,
    project_bin_dir: Path | None,
) -> ThumbnailStoryboard | None:
    """用 ffmpeg 抽帧拼成精灵图；失败时返回 None，让播放器降级为无预览。"""
    ffmpeg_path = resolve_tool(configured_ffmpeg_path, "ffmpeg", project_bin_dir)
    storyboard = build_thumbnail_storyboard(duration_seconds) if duration_seconds else None
    if not ffmpeg_path or not storyboard:
        return None

    sprite_file = asset_directory / storyboard.sprite_path
    rows = storyboard_rows(storyboard)
    filter_graph = (
        f"fps=1/{storyboard.interval_seconds},"
        f"scale={storyboard.tile_width}:{storyboard.tile_height},"
        f"tile={storyboard.columns}x{rows}"
    )
    command = [
        ffmpeg_path,
        "-hide_banner",
        "-y",
        "-i",
        str(video_path),
        "-vf",
        filter_graph,
        "-frames:v",
        "1",
        "-q:v",
        SPRITE_JPEG_QUALITY,
        str(sprite_file),
    ]
    result = subprocess.run(
        command,
        capture_output=True,
        check=False,
        text=True,
        timeout=SPRITE_GENERATION_TIMEOUT_SECONDS,
    )
    if result.returncode != 0 or not sprite_file.is_file() or sprite_file.stat().st_size == 0:
        return None
    return storyboard
