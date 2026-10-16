"""把当前字幕转换为独立字幕文件或带字幕视频。"""

from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass
from html import escape
from math import isfinite
from pathlib import Path

from openvideo.core.media_models import (
    SubtitleBackground,
    SubtitleDisplaySettings,
    SubtitleFileFormat,
    SubtitleFontSize,
    SubtitlePosition,
)
from openvideo.core.transcription_models import TranscriptSegment
from openvideo.tools.media import resolve_tool


SUBTITLE_EXPORT_TIMEOUT_SECONDS = 21_600
MILLISECONDS_PER_SECOND = 1_000
MILLISECONDS_PER_MINUTE = 60_000
MILLISECONDS_PER_HOUR = 3_600_000
SUBTITLE_TEXT_CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
SUBTITLE_PLAY_RESOLUTION_X = 1920
SUBTITLE_PLAY_RESOLUTION_Y = 1080
SUBTITLE_FONT_NAME = "Microsoft YaHei"
SUBTITLE_FONT_SIZE_POINTS = {
    SubtitleFontSize.SMALL: 36,
    SubtitleFontSize.MEDIUM: 48,
    SubtitleFontSize.LARGE: 64,
}


@dataclass(frozen=True)
class SubtitlePositionStyle:
    alignment: int
    margin_vertical: int


@dataclass(frozen=True)
class SubtitleBackgroundStyle:
    border_style: int
    outline: float
    shadow: float
    back_colour: str


SUBTITLE_POSITION_STYLES = {
    SubtitlePosition.BOTTOM: SubtitlePositionStyle(alignment=2, margin_vertical=54),
    SubtitlePosition.RAISED: SubtitlePositionStyle(alignment=2, margin_vertical=180),
    SubtitlePosition.CENTER: SubtitlePositionStyle(alignment=5, margin_vertical=0),
}
SUBTITLE_BACKGROUND_STYLES = {
    SubtitleBackground.NONE: SubtitleBackgroundStyle(
        border_style=1,
        outline=0,
        shadow=0,
        back_colour="&H00000000",
    ),
    SubtitleBackground.SHADOW: SubtitleBackgroundStyle(
        border_style=1,
        outline=1.5,
        shadow=1.5,
        back_colour="&H00000000",
    ),
    SubtitleBackground.SOLID: SubtitleBackgroundStyle(
        border_style=3,
        outline=0,
        shadow=0,
        back_colour="&H78000000",
    ),
}


class SubtitleExportError(RuntimeError):
    """导出必须返回可理解的用户错误，不能泄漏 FFmpeg 的原始诊断信息。"""


class SubtitleExportUnavailableError(SubtitleExportError):
    """缺少媒体工具时允许 API 区分环境问题与视频转换失败。"""


def render_subtitle_file(
    segments: list[TranscriptSegment],
    file_format: SubtitleFileFormat,
    *,
    offset_milliseconds: int = 0,
    duration_seconds: float | None = None,
) -> str:
    """独立文件沿用播放器的字幕偏移，且不能让文本内容成为额外字幕块。"""
    duration_milliseconds = None
    if duration_seconds is not None and isfinite(duration_seconds):
        scaled_duration = max(0, duration_seconds) * MILLISECONDS_PER_SECOND
        if isfinite(scaled_duration):
            duration_milliseconds = round(scaled_duration)

    cues: list[tuple[int, int, str]] = []
    for segment in segments:
        start = segment.start_seconds * MILLISECONDS_PER_SECOND
        end = segment.end_seconds * MILLISECONDS_PER_SECOND
        if not isfinite(start) or not isfinite(end) or end <= start:
            continue
        start_milliseconds = max(0, round(start) - offset_milliseconds)
        end_milliseconds = max(0, round(end) - offset_milliseconds)
        if duration_milliseconds is not None:
            end_milliseconds = min(end_milliseconds, duration_milliseconds)
        if end_milliseconds <= start_milliseconds:
            continue
        text = segment.text.replace("\r\n", "\n").replace("\r", "\n")
        text = SUBTITLE_TEXT_CONTROL_CHARACTERS.sub("", text)
        text = "\n".join(line for line in text.split("\n") if line.strip()).strip()
        if text:
            cues.append((start_milliseconds, end_milliseconds, text))
    cues.sort(key=lambda cue: (cue[0], cue[1]))
    if not cues:
        raise SubtitleExportError("当前视频没有可导出的字幕")
    if file_format == SubtitleFileFormat.TXT:
        return "\n\n".join(text for _, _, text in cues) + "\n"

    blocks: list[str] = []
    separator = "," if file_format == SubtitleFileFormat.SRT else "."
    for index, (start, end, text) in enumerate(cues, start=1):
        timing = (
            f"{subtitle_file_timestamp(start, separator)} --> "
            f"{subtitle_file_timestamp(end, separator)}"
        )
        # 转义箭头和标签，使转写原文只作为字幕内容而不被解释为时码或样式。
        cue = f"{timing}\n{escape(text, quote=False)}"
        if file_format == SubtitleFileFormat.SRT:
            cue = f"{index}\n{cue}"
        blocks.append(cue)
    header = "WEBVTT\n\n" if file_format == SubtitleFileFormat.VTT else ""
    return header + "\n\n".join(blocks) + "\n"


def subtitle_file_timestamp(milliseconds: int, separator: str) -> str:
    hours, remainder = divmod(milliseconds, MILLISECONDS_PER_HOUR)
    minutes, remainder = divmod(remainder, MILLISECONDS_PER_MINUTE)
    seconds, fraction = divmod(remainder, MILLISECONDS_PER_SECOND)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}{separator}{fraction:03d}"


def export_subtitled_video(
    media_path: Path,
    segments: list[TranscriptSegment],
    settings: SubtitleDisplaySettings,
    output_path: Path,
    configured_ffmpeg_path: str | None,
    project_bin_dir: Path | None = None,
) -> None:
    if not media_path.is_file():
        raise SubtitleExportError("视频文件不存在")
    usable_segments = [segment for segment in segments if segment.text.strip()]
    if not usable_segments:
        raise SubtitleExportError("当前视频没有可导出的字幕")
    ffmpeg_path = resolve_tool(configured_ffmpeg_path, "ffmpeg", project_bin_dir)
    if ffmpeg_path is None:
        raise SubtitleExportUnavailableError("未找到 ffmpeg，无法导出带字幕视频")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    subtitle_path = output_path.with_suffix(".ass")
    temporary_output_path = output_path.with_name(f".{output_path.stem}.pending.mp4")
    subtitle_path.write_text(
        build_ass_document(usable_segments, settings),
        encoding="utf-8-sig",
    )
    command = [
        ffmpeg_path,
        "-hide_banner",
        "-y",
        "-i",
        str(media_path),
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-sn",
        "-dn",
        "-vf",
        f"ass=filename='{escape_filter_path(subtitle_path)}'",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        str(temporary_output_path),
    ]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            check=False,
            text=True,
            timeout=SUBTITLE_EXPORT_TIMEOUT_SECONDS,
        )
        if (
            result.returncode != 0
            or not temporary_output_path.is_file()
            or temporary_output_path.stat().st_size == 0
        ):
            raise SubtitleExportError("带字幕视频导出失败")
        os.replace(temporary_output_path, output_path)
    except subprocess.TimeoutExpired as error:
        raise SubtitleExportError("带字幕视频导出超时") from error
    finally:
        subtitle_path.unlink(missing_ok=True)
        temporary_output_path.unlink(missing_ok=True)


def build_ass_document(
    segments: list[TranscriptSegment], settings: SubtitleDisplaySettings
) -> str:
    position_style = SUBTITLE_POSITION_STYLES[settings.position]
    background_style = SUBTITLE_BACKGROUND_STYLES[settings.background]
    font_size = SUBTITLE_FONT_SIZE_POINTS[settings.font_size]
    style = (
        f"Style: Default,{SUBTITLE_FONT_NAME},{font_size},&H00FFFFFF,&H000000FF,"
        f"&H00000000,{background_style.back_colour},0,0,0,0,100,100,0,0,"
        f"{background_style.border_style},{background_style.outline},"
        f"{background_style.shadow},{position_style.alignment},64,64,"
        f"{position_style.margin_vertical},1"
    )
    dialogue_lines = [
        "Dialogue: 0,"
        f"{ass_timestamp(segment.start_seconds)},"
        f"{ass_timestamp(max(segment.end_seconds, segment.start_seconds + 0.01))},"
        "Default,,0,0,0,,"
        f"{escape_ass_text(segment.text)}"
        for segment in segments
        if segment.text.strip()
    ]
    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {SUBTITLE_PLAY_RESOLUTION_X}",
        f"PlayResY: {SUBTITLE_PLAY_RESOLUTION_Y}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        style,
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
        "Effect, Text",
        *dialogue_lines,
        "",
    ]
    return "\n".join(lines)


def ass_timestamp(seconds: float) -> str:
    centiseconds = max(0, round(seconds * 100))
    hours, remainder = divmod(centiseconds, 360_000)
    minutes, remainder = divmod(remainder, 6_000)
    whole_seconds, fraction = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{whole_seconds:02d}.{fraction:02d}"


def escape_ass_text(text: str) -> str:
    normalized = text.strip().replace("\\", r"\\")
    normalized = normalized.replace("{", "｛").replace("}", "｝")
    return normalized.replace("\r\n", r"\N").replace("\r", r"\N").replace("\n", r"\N")


def escape_filter_path(path: Path) -> str:
    normalized = path.resolve().as_posix()
    escaped = normalized.replace("\\", r"\\").replace(":", r"\:")
    return escaped.replace("'", r"\'").replace(",", r"\,")
