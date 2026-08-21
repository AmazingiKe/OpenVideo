import json
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import httpx

from openvideo.core.models import SourcePlatform
from openvideo.tools.media import resolve_tool


OUTPUT_PREFIX = "openvideo-output:"
PROGRESS_PREFIX = "openvideo-progress:"
PERCENT_PATTERN = re.compile(r"([0-9]+(?:\.[0-9]+)?)")
COMMAND_TIMEOUT_SECONDS = 60 * 60 * 6
MAX_DIAGNOSTIC_LINES = 30
PLAYLIST_PROBE_LIMIT = 100
BILIBILI_VIEW_API_URL = "https://api.bilibili.com/x/web-interface/view"
BILIBILI_VIEW_TIMEOUT_SECONDS = 20
BILIBILI_VIEW_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.bilibili.com/",
}

# 浏览器 <video> 直接播放依赖 H.264/AAC；各平台按可得性给出优先级递减的 format 表达式。
_FORMAT_BY_PLATFORM = {
    SourcePlatform.BILIBILI: (
        "bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/"
        "bestvideo[vcodec^=avc1]+bestaudio/best[ext=mp4]/best"
    ),
    SourcePlatform.DOUYIN: "best[ext=mp4]/best",
    SourcePlatform.YOUTUBE: "best[ext=mp4]/best",
}


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


@dataclass(frozen=True)
class PlaylistEntry:
    source_video_id: str
    url: str
    title: str | None
    duration_seconds: float | None
    uploader: str | None


@dataclass(frozen=True)
class PlaylistProbe:
    """探测结果：区分单视频与播放列表，条目仅含快速可得的浅层信息。"""

    is_playlist: bool
    title: str | None
    entries: list[PlaylistEntry]
    truncated: bool
    total_count: int


ProgressCallback = Callable[[float, str], None]
StageCallback = Callable[[str], None]


def yt_dlp_available() -> bool:
    command = [sys.executable, "-m", "yt_dlp", "--version"]
    result = subprocess.run(command, capture_output=True, check=False, timeout=10)
    return result.returncode == 0


def download_video(
    source_url: str,
    platform: SourcePlatform,
    asset_directory: Path,
    configured_ffmpeg_path: str | None,
    project_bin_dir: Path | None,
    on_progress: ProgressCallback,
    on_stage: StageCallback,
    cookie_source: Path | None = None,
    staging_directory: Path | None = None,
) -> DownloadedMedia:
    """下载先进入隔离目录，只有工具成功退出并验证文件后才发布给播放器。

    cookie_source 为登录下载预留：本版所有平台均为公开免登录，调用方恒传 None。
    """
    if not yt_dlp_available():
        raise DownloadFailure("未安装 yt-dlp，请先执行 uv sync")
    ffmpeg_path = resolve_tool(configured_ffmpeg_path, "ffmpeg", project_bin_dir)
    if not ffmpeg_path:
        raise DownloadFailure("未找到 ffmpeg，请安装后加入 PATH 或配置 OPENVIDEO_FFMPEG_PATH")

    staging_directory = staging_directory or asset_directory / ".staging"
    if staging_directory.exists():
        shutil.rmtree(staging_directory)
    staging_directory.mkdir(parents=True)

    on_stage("正在读取视频信息")
    metadata = _read_metadata(source_url, platform, cookie_source)
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
        *_platform_arguments(platform),
        "--retries",
        "10",
        "--fragment-retries",
        "10",
        "--ffmpeg-location",
        ffmpeg_path,
        "--format",
        _FORMAT_BY_PLATFORM[platform],
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
        *_cookie_arguments(cookie_source),
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


def _read_metadata(
    source_url: str,
    platform: SourcePlatform,
    cookie_source: Path | None = None,
) -> DownloadMetadata:
    command = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--no-playlist",
        "--no-warnings",
        "--skip-download",
        "--dump-single-json",
        *_platform_arguments(platform),
        *_cookie_arguments(cookie_source),
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
        raise DownloadFailure("无法解析视频信息") from error
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


def probe_source(
    source_url: str,
    platform: SourcePlatform,
    source_video_id: str | None,
    cookie_source: Path | None = None,
) -> PlaylistProbe:
    """先补全平台独有的合集信息，再回退到 yt-dlp 的通用列表探测。"""
    if platform == SourcePlatform.BILIBILI and source_video_id:
        season_probe = probe_bilibili_ugc_season(source_video_id)
        if season_probe is not None:
            return season_probe
    return probe_playlist(source_url, cookie_source)


def probe_bilibili_ugc_season(source_video_id: str) -> PlaylistProbe | None:
    """Bilibili 普通视频 URL 不携带合集参数时，仍从视频详情中找出其所属的 UGC 合集。"""
    try:
        response = httpx.get(
            BILIBILI_VIEW_API_URL,
            params={"bvid": source_video_id},
            headers=BILIBILI_VIEW_HEADERS,
            timeout=BILIBILI_VIEW_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError):
        return None
    if not isinstance(payload, dict) or payload.get("code") != 0:
        return None
    data = payload.get("data")
    if not isinstance(data, dict):
        return None
    season = data.get("ugc_season")
    if not isinstance(season, dict):
        return None

    entries = _bilibili_season_entries(season)
    if not entries:
        return None
    total_count = len(entries)
    visible_entries = entries[:PLAYLIST_PROBE_LIMIT]
    return PlaylistProbe(
        is_playlist=True,
        title=_optional_text(season.get("title")),
        entries=visible_entries,
        truncated=total_count > len(visible_entries),
        total_count=total_count,
    )


def _bilibili_season_entries(season: dict) -> list[PlaylistEntry]:
    entries: list[PlaylistEntry] = []
    sections = season.get("sections")
    if not isinstance(sections, list):
        return entries
    for section in sections:
        if not isinstance(section, dict):
            continue
        episodes = section.get("episodes")
        if not isinstance(episodes, list):
            continue
        for episode in episodes:
            entry = _bilibili_season_entry(episode)
            if entry is not None:
                entries.append(entry)
    return entries


def _bilibili_season_entry(episode: object) -> PlaylistEntry | None:
    if not isinstance(episode, dict):
        return None
    source_video_id = _optional_text(episode.get("bvid"))
    if not source_video_id:
        return None
    arc = episode.get("arc")
    metadata = arc if isinstance(arc, dict) else {}
    author = metadata.get("author")
    author_data = author if isinstance(author, dict) else {}
    return PlaylistEntry(
        source_video_id=source_video_id,
        url=f"https://www.bilibili.com/video/{source_video_id}",
        title=_optional_text(episode.get("title")) or _optional_text(metadata.get("title")),
        duration_seconds=_optional_float(metadata.get("duration")),
        uploader=_optional_text(author_data.get("name")),
    )


def probe_playlist(source_url: str, cookie_source: Path | None = None) -> PlaylistProbe:
    """快速探测地址是单视频还是播放列表；播放列表只拉浅层条目，不触发下载。"""
    command = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--no-warnings",
        "--skip-download",
        "--flat-playlist",
        "--dump-single-json",
        "--playlist-end",
        str(PLAYLIST_PROBE_LIMIT),
        *_cookie_arguments(cookie_source),
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
        raise DownloadFailure("无法解析视频信息") from error
    return parse_playlist_payload(payload)


def parse_playlist_payload(payload: dict) -> PlaylistProbe:
    """把 yt-dlp 的 --flat-playlist JSON 转成探测结果，供单测直接复用。"""
    raw_entries = payload.get("entries")
    if not isinstance(raw_entries, list):
        entry = _single_entry(payload)
        return PlaylistProbe(
            is_playlist=False,
            title=None,
            entries=[entry] if entry else [],
            truncated=False,
            total_count=1 if entry else 0,
        )
    entries = [entry for item in raw_entries if (entry := _single_entry(item))]
    total_count = _optional_int(payload.get("playlist_count")) or len(entries)
    return PlaylistProbe(
        is_playlist=True,
        title=_optional_text(payload.get("title")),
        entries=entries,
        truncated=total_count > len(entries),
        total_count=total_count,
    )


def _single_entry(item: object) -> PlaylistEntry | None:
    if not isinstance(item, dict):
        return None
    video_id = _optional_text(item.get("id"))
    if not video_id:
        return None
    return PlaylistEntry(
        source_video_id=video_id,
        url=_optional_text(item.get("url")) or _optional_text(item.get("webpage_url")) or "",
        title=_optional_text(item.get("title")),
        duration_seconds=_optional_float(item.get("duration")),
        uploader=_optional_text(item.get("uploader")),
    )


def _platform_arguments(platform: SourcePlatform) -> list[str]:
    # YouTube 当前对默认 android_vr 客户端返回的媒体直链可能 403；android 客户端提供可直接下载的 MP4。
    if platform == SourcePlatform.YOUTUBE:
        return ["--extractor-args", "youtube:player_client=android"]
    return []


def _cookie_arguments(cookie_source: Path | None) -> list[str]:
    # 预留位：本版恒为 None，将来登录下载时传入 cookies 文件路径。
    if cookie_source is None:
        return []
    return ["--cookies", str(cookie_source)]


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
    if "fresh cookies" in lowered:
        return "平台要求新的会话信息，当前版本不会读取或保存浏览器 Cookie，请稍后重试"
    if "login" in lowered or "cookie" in lowered:
        return "该视频可能需要登录，当前版本只支持公开视频免费下载"
    if "unsupported url" in lowered:
        return "yt-dlp 无法识别该视频地址"
    if "private" in lowered or "permission" in lowered:
        return "该视频不可公开访问"
    return "视频下载失败，请确认地址有效且网络可以访问对应平台"


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
