"""从视频生成可嵌入总结文档的静态图与短 GIF。"""

import subprocess
from pathlib import Path

from openvideo.core.summary_models import SummaryMediaType
from openvideo.tools.media import resolve_tool


GIF_DEFAULT_DURATION_SECONDS = 6.0
GIF_MAX_DURATION_SECONDS = 15.0
GIF_WIDTH_PIXELS = 720
GIF_FRAMES_PER_SECOND = 10
MEDIA_COMMAND_TIMEOUT_SECONDS = 180


class SummaryMediaError(RuntimeError):
    """媒体建议无法安全转换为文档资源时保留明确的用户错误。"""


def generate_summary_media(
    media_path: Path,
    output_path: Path,
    media_type: SummaryMediaType,
    start_seconds: float,
    end_seconds: float | None,
    configured_ffmpeg_path: str | None,
    project_bin_dir: Path | None = None,
) -> None:
    if not media_path.is_file():
        raise SummaryMediaError("视频文件不存在")
    ffmpeg_path = resolve_tool(configured_ffmpeg_path, "ffmpeg", project_bin_dir)
    if ffmpeg_path is None:
        raise SummaryMediaError("未找到 ffmpeg")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if media_type == SummaryMediaType.IMAGE:
        command = [
            ffmpeg_path,
            "-y",
            "-ss",
            str(start_seconds),
            "-i",
            str(media_path),
            "-frames:v",
            "1",
            str(output_path),
        ]
    else:
        duration = (
            end_seconds - start_seconds
            if end_seconds is not None
            else GIF_DEFAULT_DURATION_SECONDS
        )
        if duration <= 0 or duration > GIF_MAX_DURATION_SECONDS:
            raise SummaryMediaError("GIF 时长必须大于 0 秒且不超过 15 秒")
        video_filter = (
            f"fps={GIF_FRAMES_PER_SECOND},"
            f"scale={GIF_WIDTH_PIXELS}:-2:flags=lanczos"
        )
        command = [
            ffmpeg_path,
            "-y",
            "-ss",
            str(start_seconds),
            "-t",
            str(duration),
            "-i",
            str(media_path),
            "-vf",
            video_filter,
            "-an",
            str(output_path),
        ]
    result = subprocess.run(
        command,
        capture_output=True,
        check=False,
        text=True,
        timeout=MEDIA_COMMAND_TIMEOUT_SECONDS,
    )
    if result.returncode != 0 or not output_path.is_file():
        raise SummaryMediaError("总结媒体生成失败")
