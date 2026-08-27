import os
import subprocess
import tempfile
import threading
from pathlib import Path

from openvideo.core.thumbnails import (
    SCRUB_PROXY_FILE_NAME,
    ThumbnailStoryboard,
    build_thumbnail_storyboard,
    storyboard_rows,
)
from openvideo.tools.media import resolve_tool

SPRITE_GENERATION_TIMEOUT_SECONDS = 600
SPRITE_JPEG_QUALITY = "4"
SCRUB_PROXY_GENERATION_TIMEOUT_SECONDS = 1_800
SCRUB_PROXY_HEIGHT = 480
SCRUB_PROXY_GROUP_OF_PICTURES = 15
SCRUB_PROXY_CONSTANT_RATE_FACTOR = 36
SCRUB_PROXY_GENERATION_LOCK = threading.Lock()


def generate_thumbnail_sprite(
    video_path: Path,
    asset_directory: Path,
    duration_seconds: float | None,
    configured_ffmpeg_path: str | None,
    project_bin_dir: Path | None,
) -> ThumbnailStoryboard | None:
    """用 ffmpeg 抽帧拼成精灵图；失败时返回 None，让播放器降级为无预览。"""
    ffmpeg_path = resolve_tool(configured_ffmpeg_path, "ffmpeg", project_bin_dir)
    storyboard = (
        build_thumbnail_storyboard(duration_seconds) if duration_seconds else None
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
    result = subprocess.run(
        command,
        capture_output=True,
        check=False,
        text=True,
        timeout=SPRITE_GENERATION_TIMEOUT_SECONDS,
    )
    if (
        result.returncode != 0
        or not sprite_file.is_file()
        or sprite_file.stat().st_size == 0
    ):
        return None
    return storyboard


def generate_scrub_proxy(
    video_path: Path,
    asset_directory: Path,
    configured_ffmpeg_path: str | None,
    project_bin_dir: Path | None,
) -> Path | None:
    """生成面向随机定位的轻量视频，避免时间线拖动反复解码原始大画面。"""
    asset_directory.mkdir(parents=True, exist_ok=True)
    proxy_file = asset_directory / SCRUB_PROXY_FILE_NAME
    if proxy_file.is_file() and proxy_file.stat().st_size > 0:
        return proxy_file

    ffmpeg_path = resolve_tool(configured_ffmpeg_path, "ffmpeg", project_bin_dir)
    if not ffmpeg_path:
        return None

    with SCRUB_PROXY_GENERATION_LOCK:
        if proxy_file.is_file() and proxy_file.stat().st_size > 0:
            return proxy_file

        temporary_file = _temporary_proxy_path(asset_directory)
        scale_filter = f"scale=-2:min({SCRUB_PROXY_HEIGHT}\\,ih)"
        command = [
            ffmpeg_path,
            "-hide_banner",
            "-y",
            "-i",
            str(video_path),
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-vf",
            scale_filter,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-tune",
            "fastdecode",
            "-crf",
            str(SCRUB_PROXY_CONSTANT_RATE_FACTOR),
            "-g",
            str(SCRUB_PROXY_GROUP_OF_PICTURES),
            "-keyint_min",
            str(SCRUB_PROXY_GROUP_OF_PICTURES),
            "-sc_threshold",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(temporary_file),
        ]
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                check=False,
                text=True,
                timeout=SCRUB_PROXY_GENERATION_TIMEOUT_SECONDS,
            )
            if (
                result.returncode != 0
                or not temporary_file.is_file()
                or temporary_file.stat().st_size == 0
            ):
                return None
            os.replace(temporary_file, proxy_file)
            return proxy_file
        except subprocess.TimeoutExpired:
            return None
        finally:
            temporary_file.unlink(missing_ok=True)


def _temporary_proxy_path(asset_directory: Path) -> Path:
    with tempfile.NamedTemporaryFile(
        dir=asset_directory,
        prefix=".scrub-proxy-",
        suffix=".mp4",
        delete=False,
    ) as temporary_file:
        return Path(temporary_file.name)
