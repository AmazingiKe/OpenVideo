import json
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from openvideo.tools.media import resolve_tool


OUTPUT_PREFIX = "openvideo-output:"
PROGRESS_PREFIX = "openvideo-progress:"
PERCENT_PATTERN = re.compile(r"([0-9]+(?:\.[0-9]+)?)")
COMMAND_TIMEOUT_SECONDS = 60 * 60 * 6
MAX_DIAGNOSTIC_LINES = 30


class DownloadFailure(RuntimeError):
    pass


@dataclass(frozen=True)
class DownloadMetadata:
    source_video_id: str
    title: str
    author_name: str | None
    description: str | None
    duration_seconds: float | None
    width: int | None
    height: int | None
    thumbnail_url: str | None


@dataclass(frozen=True)
class DownloadedMedia:
    metadata: DownloadMetadata
    playback_file: Path
    thumbnail_file: Path | None


ProgressCallback = Callable[[float, str], None]
StageCallback = Callable[[str], None]


def yt_dlp_available() -> bool:
    command = [sys.executable, "-m", "yt_dlp", "--version"]
    result = subprocess.run(command, capture_output=True, check=False, timeout=10)
    return result.returncode == 0


def download_bilibili_video(
    source_url: str,
    asset_directory: Path,
    configured_ffmpeg_path: str | None,
    project_bin_dir: Path | None,
    on_progress: ProgressCallback,
    on_stage: StageCallback,
) -> DownloadedMedia:
    """下载先进入隔离目录，只有工具成功退出并验证文件后才发布给播放器。"""
    if not yt_dlp_available():
        raise DownloadFailure("未安装 yt-dlp，请先执行 uv sync")
    ffmpeg_path = resolve_tool(configured_ffmpeg_path, "ffmpeg", project_bin_dir)
    if not ffmpeg_path:
        raise DownloadFailure("未找到 ffmpeg，请安装后加入 PATH 或配置 OPENVIDEO_FFMPEG_PATH")

    staging_directory = asset_directory / ".staging"
    if staging_directory.exists():
        shutil.rmtree(staging_directory)
    staging_directory.mkdir(parents=True)

    on_stage("正在读取 Bilibili 视频信息")
    metadata = _read_metadata(source_url)
    on_stage("正在下载视频和音频")
    temporary_template = staging_directory / "download.%(ext)s"
    command = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--newline",
        "--progress",
        "--no-playlist",
        "--no-warnings",
        "--ffmpeg-location",
        ffmpeg_path,
        "--format",
        "bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[vcodec^=avc1]+bestaudio/best[ext=mp4]/best",
        "--merge-output-format",
        "mp4",
        "--write-thumbnail",
        "--convert-thumbnails",
        "jpg",
        "--progress-template",
        f"download:{PROGRESS_PREFIX}%(progress._percent_str)s",
        "--print",
        f"after_move:{OUTPUT_PREFIX}%(filepath)s",
        "--output",
        str(temporary_template),
        source_url,
    ]
    output_file = _run_download(command, staging_directory, on_progress)
    published_file = _publish_file(output_file, asset_directory)
    thumbnail_file = _publish_thumbnail(staging_directory, asset_directory)
    shutil.rmtree(staging_directory, ignore_errors=True)
    return DownloadedMedia(
        metadata=metadata,
        playback_file=published_file,
        thumbnail_file=thumbnail_file,
    )


def _read_metadata(source_url: str) -> DownloadMetadata:
    command = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--no-playlist",
        "--no-warnings",
        "--skip-download",
        "--dump-single-json",
        source_url,
    ]
    result = subprocess.run(
        command,
        capture_output=True,
        check=False,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise DownloadFailure(_friendly_failure(result.stderr or result.stdout))
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise DownloadFailure("无法解析 Bilibili 视频信息") from error
    source_video_id = _required_text(payload.get("id"), "未识别到视频 ID")
    title = _required_text(payload.get("title"), "未识别到视频标题")
    return DownloadMetadata(
        source_video_id=source_video_id,
        title=title,
        author_name=_optional_text(payload.get("uploader")),
        description=_optional_text(payload.get("description")),
        duration_seconds=_optional_float(payload.get("duration")),
        width=_optional_int(payload.get("width")),
        height=_optional_int(payload.get("height")),
        thumbnail_url=_optional_text(payload.get("thumbnail")),
    )


def _run_download(
    command: list[str],
    staging_directory: Path,
    on_progress: ProgressCallback,
) -> Path:
    process = subprocess.Popen(
        command,
        cwd=staging_directory,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    output_file: Path | None = None
    diagnostics: list[str] = []
    assert process.stdout is not None
    for raw_line in process.stdout:
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith(PROGRESS_PREFIX):
            percent = parse_progress_percent(line)
            if percent is not None:
                on_progress(percent, "正在下载视频")
            continue
        if line.startswith(OUTPUT_PREFIX):
            output_file = Path(line.removeprefix(OUTPUT_PREFIX).strip())
            continue
        diagnostics.append(line)
        diagnostics = diagnostics[-MAX_DIAGNOSTIC_LINES:]
    try:
        return_code = process.wait(timeout=COMMAND_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as error:
        process.kill()
        raise DownloadFailure("视频下载超时") from error
    if return_code != 0:
        raise DownloadFailure(_friendly_failure("\n".join(diagnostics)))
    if output_file is None:
        raise DownloadFailure("下载已结束，但没有找到生成的视频文件")
    resolved_output = output_file.resolve()
    resolved_staging = staging_directory.resolve()
    if not resolved_output.is_relative_to(resolved_staging):
        raise DownloadFailure("下载工具返回了资源目录外的文件")
    if not resolved_output.is_file() or resolved_output.is_symlink() or resolved_output.stat().st_size == 0:
        raise DownloadFailure("下载结果不完整，无法发布")
    return resolved_output


def parse_progress_percent(line: str) -> float | None:
    """从 yt-dlp 进度行提取百分比，未知格式或异常值返回 None。"""
    if not line.startswith(PROGRESS_PREFIX):
        return None
    percent_match = PERCENT_PATTERN.search(line.removeprefix(PROGRESS_PREFIX))
    if not percent_match:
        return None
    try:
        return min(float(percent_match.group(1)), 100)
    except ValueError:
        return None


def _publish_file(output_file: Path, asset_directory: Path) -> Path:
    extension = output_file.suffix.casefold()
    if extension not in {".mp4", ".m4v"}:
        raise DownloadFailure("下载结果不是浏览器可播放的 MP4 视频")
    published_file = asset_directory / "playback.mp4"
    os.replace(output_file, published_file)
    return published_file


def _publish_thumbnail(staging_directory: Path, asset_directory: Path) -> Path | None:
    thumbnail_candidates = [
        candidate
        for candidate in staging_directory.glob("download.*")
        if candidate.suffix.casefold() in {".jpg", ".jpeg", ".png", ".webp"}
    ]
    if not thumbnail_candidates:
        return None
    source_file = thumbnail_candidates[0].resolve()
    if not source_file.is_relative_to(staging_directory.resolve()) or source_file.is_symlink():
        return None
    extension = source_file.suffix.casefold()
    published_file = asset_directory / f"thumbnail{extension}"
    os.replace(source_file, published_file)
    return published_file


def _friendly_failure(diagnostic: str) -> str:
    lowered = diagnostic.casefold()
    if "login" in lowered or "cookie" in lowered:
        return "该视频可能需要登录，当前版本只支持公开视频免费下载"
    if "unsupported url" in lowered:
        return "yt-dlp 无法识别该 Bilibili 地址"
    if "private" in lowered or "permission" in lowered:
        return "该视频不可公开访问"
    return "视频下载失败，请确认地址有效且网络可以访问 Bilibili"


def _required_text(value: object, message: str) -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()
    raise DownloadFailure(message)


def _optional_text(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _optional_float(value: object) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _optional_int(value: object) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None
