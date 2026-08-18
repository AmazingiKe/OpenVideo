import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


PROBE_TIMEOUT_SECONDS = 30


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
        ffmpeg_available=resolve_tool(ffmpeg_path, "ffmpeg", project_bin_dir) is not None,
        ffprobe_available=resolve_tool(ffprobe_path, "ffprobe", project_bin_dir) is not None,
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
    streams = payload.get("streams", [])
    video_stream = next((stream for stream in streams if stream.get("codec_type") == "video"), {})
    audio_stream = next((stream for stream in streams if stream.get("codec_type") == "audio"), {})
    duration = payload.get("format", {}).get("duration")
    return MediaProbe(
        duration_seconds=_optional_float(duration),
        width=_optional_int(video_stream.get("width")),
        height=_optional_int(video_stream.get("height")),
        video_codec=_optional_text(video_stream.get("codec_name")),
        audio_codec=_optional_text(audio_stream.get("codec_name")),
    )


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


def _optional_text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None
