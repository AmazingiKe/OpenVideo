import subprocess
import tempfile
from pathlib import Path

from openvideo.core.identifiers import uuid7
from openvideo.core.library_files import atomic_write_model
from openvideo.core.thumbnails import (
    STORYBOARD_ROWS,
    ThumbnailStoryboardManifest,
    ThumbnailStoryboardPage,
    ThumbnailStoryboardPlan,
    build_thumbnail_storyboard_plan,
    storyboard_page_tile_count,
)
from openvideo.tools.media import resolve_tool


STORYBOARD_GENERATION_TIMEOUT_SECONDS = 30 * 60
STORYBOARD_JPEG_QUALITY = "4"
STORYBOARD_PROCESS_THREADS = "1"
STORYBOARD_PAGE_FILE_PATTERN = "page-%04d.jpg"
STORYBOARD_PAGE_ID_PREFIX = "storyboard-page-"
STORYBOARD_ID_PREFIX = "storyboard-"


def generate_thumbnail_storyboard(
    video_path: Path,
    media_directory: Path,
    duration_seconds: float | None,
    source_width: int | None,
    source_height: int | None,
    configured_ffmpeg_path: str | None,
    project_bin_dir: Path | None,
) -> Path | None:
    """生成可按页缓存的低优先级预览图，避免长视频拖动争用主播放解码器。"""
    ffmpeg_path = resolve_tool(configured_ffmpeg_path, "ffmpeg", project_bin_dir)
    plan = build_thumbnail_storyboard_plan(
        duration_seconds,
        source_width,
        source_height,
    )
    if not ffmpeg_path or not plan:
        return None

    media_directory.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="openvideo-storyboard-",
        dir=media_directory,
    ) as temporary_directory:
        temporary_path = Path(temporary_directory)
        output_pattern = temporary_path / STORYBOARD_PAGE_FILE_PATTERN
        try:
            result = subprocess.run(
                _storyboard_command(ffmpeg_path, video_path, output_pattern, plan),
                capture_output=True,
                check=False,
                text=True,
                timeout=STORYBOARD_GENERATION_TIMEOUT_SECONDS,
                creationflags=getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0),
            )
        except subprocess.TimeoutExpired:
            return None
        page_files = sorted(temporary_path.glob("page-*.jpg"))
        if (
            result.returncode != 0
            or len(page_files) != plan.page_count
            or any(page_file.stat().st_size == 0 for page_file in page_files)
        ):
            return None
        return _publish_storyboard_pages(page_files, media_directory, plan)


def _storyboard_command(
    ffmpeg_path: str,
    video_path: Path,
    output_pattern: Path,
    plan: ThumbnailStoryboardPlan,
) -> list[str]:
    filter_graph = (
        f"fps=1/{plan.interval_seconds},"
        f"scale={plan.tile_width}:{plan.tile_height},"
        f"tile={plan.columns}x{STORYBOARD_ROWS}"
    )
    return [
        ffmpeg_path,
        "-hide_banner",
        "-y",
        "-threads",
        STORYBOARD_PROCESS_THREADS,
        "-i",
        str(video_path),
        "-an",
        "-sn",
        "-dn",
        "-vf",
        filter_graph,
        "-frames:v",
        str(plan.page_count),
        "-q:v",
        STORYBOARD_JPEG_QUALITY,
        str(output_pattern),
    ]


def _publish_storyboard_pages(
    page_files: list[Path],
    media_directory: Path,
    plan: ThumbnailStoryboardPlan,
) -> Path:
    storyboard_id = f"{STORYBOARD_ID_PREFIX}{uuid7().hex}"
    published_files: list[Path] = []
    pages: list[ThumbnailStoryboardPage] = []
    try:
        for page_index, source_file in enumerate(page_files):
            page_id = f"{STORYBOARD_PAGE_ID_PREFIX}{uuid7().hex}"
            destination_file = media_directory / f"{page_id}.jpg"
            source_file.replace(destination_file)
            published_files.append(destination_file)
            pages.append(
                ThumbnailStoryboardPage(
                    page_id=page_id,
                    relative_path=destination_file.relative_to(
                        media_directory.parent
                    ).as_posix(),
                    start_index=page_index * plan.columns * STORYBOARD_ROWS,
                    tile_count=storyboard_page_tile_count(plan, page_index),
                )
            )
        manifest = ThumbnailStoryboardManifest(
            storyboard_id=storyboard_id,
            tile_width=plan.tile_width,
            tile_height=plan.tile_height,
            interval_seconds=plan.interval_seconds,
            columns=plan.columns,
            total_tiles=plan.total_tiles,
            pages=pages,
        )
        manifest_file = media_directory / f"{storyboard_id}.json"
        atomic_write_model(manifest_file, manifest)
        return manifest_file
    except Exception:
        for published_file in published_files:
            published_file.unlink(missing_ok=True)
        raise
