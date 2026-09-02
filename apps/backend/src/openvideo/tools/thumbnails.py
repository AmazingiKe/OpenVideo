import subprocess
from pathlib import Path

from openvideo.core.thumbnails import (
    ThumbnailStoryboard,
    build_thumbnail_storyboard,
    storyboard_rows,
)
from openvideo.tools.media import resolve_tool

SPRITE_GENERATION_TIMEOUT_SECONDS = 90
SPRITE_JPEG_QUALITY = "4"


def generate_thumbnail_sprite(
    video_path: Path,
    asset_directory: Path,
    duration_seconds: float | None,
    source_width: int | None,
    source_height: int | None,
    configured_ffmpeg_path: str | None,
    project_bin_dir: Path | None,
) -> ThumbnailStoryboard | None:
    """仅为兼容浏览器生成受尺寸和帧数约束的响应式预览拼板。"""
    ffmpeg_path = resolve_tool(configured_ffmpeg_path, "ffmpeg", project_bin_dir)
    storyboard = (
        build_thumbnail_storyboard(
            duration_seconds,
            source_width,
            source_height,
        )
        if duration_seconds
        else None
    )
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
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            check=False,
            text=True,
            timeout=SPRITE_GENERATION_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return None
    if (
        result.returncode != 0
        or not sprite_file.is_file()
        or sprite_file.stat().st_size == 0
    ):
        return None
    return storyboard
