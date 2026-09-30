import json
import shutil
import subprocess
from dataclasses import dataclass
from math import isfinite
from pathlib import Path


PROBE_TIMEOUT_SECONDS = 30
# 编码延迟与平台时长取整允许少量偏差，长视频也不能隐藏大段缺失。
MINIMUM_DURATION_TOLERANCE_SECONDS = 2.0
MAXIMUM_DURATION_TOLERANCE_SECONDS = 10.0
DURATION_TOLERANCE_RATIO = 0.01


@dataclass(frozen=True)
class MediaToolStatus:
    ffmpeg_available: bool
    ffprobe_available: bool


@dataclass(frozen=True)
class MediaProbe:
    duration_seconds: float | None
    width: int | None
    height: int | None
    video_codec: str | None
    audio_codec: str | None
    video_duration_seconds: float | None = None
    audio_duration_seconds: float | None = None
    start_seconds: float | None = None
    video_start_seconds: float | None = None
    audio_start_seconds: float | None = None


class MediaIntegrityError(ValueError):
    """容器可播放并不保证视频轨道完整，拒绝把残缺媒体交给全片分析。"""


def resolve_tool(
    configured_path: str | None,
    tool_name: str,
    project_bin_dir: Path | None = None,
) -> str | None:
    if configured_path:
        configured_file = Path(configured_path).expanduser()
        return str(configured_file.resolve()) if configured_file.is_file() else None
    if project_bin_dir:
        project_candidate = project_bin_dir / f"{tool_name}.exe"
        if project_candidate.is_file():
            return str(project_candidate.resolve())
    return shutil.which(tool_name)


def media_tool_status(
    ffmpeg_path: str | None,
    ffprobe_path: str | None,
    project_bin_dir: Path | None = None,
) -> MediaToolStatus:
    return MediaToolStatus(
        ffmpeg_available=resolve_tool(ffmpeg_path, "ffmpeg", project_bin_dir)
        is not None,
        ffprobe_available=resolve_tool(ffprobe_path, "ffprobe", project_bin_dir)
        is not None,
    )


def probe_media(
    file_path: Path,
    configured_ffprobe_path: str | None,
    project_bin_dir: Path | None = None,
) -> MediaProbe:
    ffprobe_path = resolve_tool(configured_ffprobe_path, "ffprobe", project_bin_dir)
    if not ffprobe_path:
        return MediaProbe(None, None, None, None, None)
    command = [
        ffprobe_path,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(file_path),
    ]
    result = subprocess.run(
        command,
        capture_output=True,
        check=False,
        text=True,
        timeout=PROBE_TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        return MediaProbe(None, None, None, None, None)
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        return MediaProbe(None, None, None, None, None)
    if not isinstance(payload, dict):
        return MediaProbe(None, None, None, None, None)
    streams = payload.get("streams", [])
    streams = (
        [stream for stream in streams if isinstance(stream, dict)]
        if isinstance(streams, list)
        else []
    )
    video_stream = next(
        (stream for stream in streams if stream.get("codec_type") == "video"), {}
    )
    audio_stream = next(
        (stream for stream in streams if stream.get("codec_type") == "audio"), {}
    )
    media_format = payload.get("format")
    duration = media_format.get("duration") if isinstance(media_format, dict) else None
    return MediaProbe(
        duration_seconds=_optional_float(duration),
        width=_optional_int(video_stream.get("width")),
        height=_optional_int(video_stream.get("height")),
        video_codec=_optional_text(video_stream.get("codec_name")),
        audio_codec=_optional_text(audio_stream.get("codec_name")),
        video_duration_seconds=_stream_duration(video_stream),
        audio_duration_seconds=_stream_duration(audio_stream),
        start_seconds=_optional_float(media_format.get("start_time"))
        if isinstance(media_format, dict)
        else None,
        video_start_seconds=_optional_float(video_stream.get("start_time")),
        audio_start_seconds=_optional_float(audio_stream.get("start_time")),
    )


def validate_video_duration(
    probe: MediaProbe, expected_duration_seconds: float | None
) -> None:
    """按容器起点核对视频末尾；此轻量时长检查不代替完整解码校验。"""
    if probe.video_codec is None:
        raise MediaIntegrityError("下载结果没有可识别的视频轨道，无法确认视频完整性")
    video_duration = _optional_float(probe.video_duration_seconds)
    if video_duration is None:
        raise MediaIntegrityError(
            "无法读取视频轨道时长，不能确认下载完整性，请重新下载"
        )
    origin = probe.start_seconds or 0.0
    video_start = probe.video_start_seconds
    video_end = (
        (video_start if video_start is not None else origin) + video_duration - origin
    )
    audio_start = probe.audio_start_seconds
    audio_end = (
        (audio_start if audio_start is not None else origin)
        + probe.audio_duration_seconds
        - origin
        if probe.audio_duration_seconds is not None
        else None
    )
    reference_durations = [
        duration
        for value in (
            expected_duration_seconds,
            probe.duration_seconds,
            audio_end,
        )
        if (duration := _optional_float(value)) is not None and duration > 0
    ]
    if video_duration <= 0:
        raise MediaIntegrityError("下载结果的视频轨道为空，请重新下载")
    if not reference_durations:
        return
    reference_duration = max(reference_durations)
    tolerance = max(
        MINIMUM_DURATION_TOLERANCE_SECONDS,
        min(
            MAXIMUM_DURATION_TOLERANCE_SECONDS,
            reference_duration * DURATION_TOLERANCE_RATIO,
        ),
    )
    if reference_duration - video_end > tolerance:
        raise MediaIntegrityError(
            f"媒体文件不完整：视频结束于 {video_end:.2f} 秒，"
            f"参考时长 {reference_duration:.2f} 秒，请重新下载"
        )


def _stream_duration(stream: dict) -> float | None:
    duration = _optional_float(stream.get("duration"))
    if duration is not None and duration >= 0:
        return duration
    duration_ticks = _optional_float(stream.get("duration_ts"))
    time_base = stream.get("time_base")
    if duration_ticks is None or not isinstance(time_base, str):
        return None
    try:
        numerator, denominator = (float(part) for part in time_base.split("/"))
        duration = duration_ticks * numerator / denominator
    except (ValueError, ZeroDivisionError):
        return None
    return duration if isfinite(duration) and duration >= 0 else None


def _optional_float(value: object) -> float | None:
    try:
        parsed = float(value) if value is not None else None
        return parsed if parsed is not None and isfinite(parsed) else None
    except (TypeError, ValueError):
        return None


def _optional_int(value: object) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _optional_text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None
