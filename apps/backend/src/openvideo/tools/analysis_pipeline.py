"""把转写文本编排成带画面描述的 MediaSegment。

管线顺序：启发式选重点片段 → 抽取关键帧 → 调用视觉模型描述画面 →
组装成领域层 MediaSegment。视觉描述器为空时跳过画面分析，仅保留文本与关键帧。
"""

from __future__ import annotations

from pathlib import Path

from openvideo.core.analysis import select_key_moments
from openvideo.core.analysis_models import Transcript
from openvideo.core.identifiers import uuid7
from openvideo.core.models import MediaSegment
from openvideo.settings import Settings
from openvideo.tools.frames import extract_frames
from openvideo.tools.vision import VisionDescriber


VISUAL_PROMPT = (
    "这是视频重点片段的画面。请用中文简洁描述：画面里的人物、场景，"
    "以及出现的文字、板书、幻灯片或代码等内容。"
)
FRAMES_DIRECTORY_NAME = ".analysis/frames"


def build_segments(
    transcript: Transcript,
    media_path: Path,
    asset_id: str,
    asset_directory: Path,
    settings: Settings,
    describer: VisionDescriber | None,
) -> list[MediaSegment]:
    """从转写生成 MediaSegment 列表；无画面描述器时也保留文本与关键帧。"""
    moments = select_key_moments(transcript)
    if not moments:
        return []

    time_points = [_midpoint(moment) for moment in moments]
    frames_directory = asset_directory / FRAMES_DIRECTORY_NAME
    frames = extract_frames(
        media_path,
        time_points,
        frames_directory,
        settings.ffmpeg_path,
        settings.ffmpeg_bin_dir,
    )

    segments: list[MediaSegment] = []
    for moment, frame_path in zip(moments, frames):
        description = describer.describe(frame_path, VISUAL_PROMPT) if describer else None
        segments.append(
            MediaSegment(
                segment_id=f"segment-{uuid7().hex}",
                asset_id=asset_id,
                start_seconds=moment.start_seconds,
                end_seconds=moment.end_seconds,
                transcript_text=moment.transcript_text or None,
                key_frame_paths=[_relative_to_asset(asset_directory, frame_path)],
                visual_description=description,
            )
        )
    return segments


def _midpoint(moment) -> float:
    return (moment.start_seconds + moment.end_seconds) / 2


def _relative_to_asset(asset_directory: Path, frame_path: Path) -> str:
    return frame_path.relative_to(asset_directory).as_posix()
