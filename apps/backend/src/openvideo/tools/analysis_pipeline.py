"""把转写、用户标记和代表画面编排为时间轴事件。"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from pathlib import Path

from openvideo.core.analysis import (
    MarkerInfluence,
    TimelineMoment,
    select_timeline_moments,
)
from openvideo.core.analysis_models import AnalysisStage, AnalysisStrategy
from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.identifiers import uuid7
from openvideo.core.media_models import MediaMarker, MediaSegment
from openvideo.core.transcription_models import Transcript
from openvideo.settings import Settings
from openvideo.tools.frames import FrameExtractionError, extract_frames
from openvideo.tools.scenes import detect_scene_boundaries
from openvideo.tools.chapters import build_global_semantic_chapters
from openvideo.tools.vision import VisionDescriber, VisionDescriptionError


FRAMES_DIRECTORY_NAME = "frames"
MIN_CHAPTER_FRAME_COUNT = 2
MAX_CHAPTER_FRAME_COUNT = 12
SECONDS_PER_ADAPTIVE_FRAME = 30
MAX_PROMPT_TRANSCRIPT_CHARACTERS = 6000
TITLE_MAX_CHARACTERS = 32
AnalysisProgress = Callable[[AnalysisStage, float, str], None]


def build_segments(
    transcript: Transcript,
    media_path: Path,
    asset_id: str,
    asset_directory: Path,
    duration_seconds: float | None,
    settings: Settings,
    describer: VisionDescriber | None,
    markers: list[MediaMarker],
    strategy: AnalysisStrategy,
    progress_callback: AnalysisProgress,
    chapter_model: AiModelConfiguration | None = None,
) -> list[MediaSegment]:
    """基础音频分析始终产出事件，视觉能力缺失或局部失败不会丢失文本结果。"""
    scene_boundaries = detect_scene_boundaries(
        media_path,
        settings.ffmpeg_path,
        settings.ffmpeg_bin_dir,
    )
    semantic_chapters = build_global_semantic_chapters(transcript.segments, chapter_model)
    moments = select_timeline_moments(
        transcript,
        markers,
        duration_seconds,
        scene_boundaries,
        strategy,
        semantic_chapters,
    )
    segments: list[MediaSegment] = []
    progress_span = 20 / max(len(moments), 1)
    for index, moment in enumerate(moments):
        event_number = index + 1
        progress_callback(
            AnalysisStage.EXTRACTING_FRAMES,
            75 + progress_span * index,
            f"正在提取第 {event_number}/{len(moments)} 个事件的关键帧",
        )
        segments.append(
            _build_segment(
                moment,
                media_path,
                asset_id,
                asset_directory,
                settings,
                describer,
                strategy,
                scene_boundaries,
                lambda: progress_callback(
                    AnalysisStage.DESCRIBING_VISUALS,
                    75 + progress_span * (index + 0.5),
                    f"正在分析第 {event_number}/{len(moments)} 个事件",
                ),
            )
        )
    return segments


def _build_segment(
    moment: TimelineMoment,
    media_path: Path,
    asset_id: str,
    asset_directory: Path,
    settings: Settings,
    describer: VisionDescriber | None,
    strategy: AnalysisStrategy,
    scene_boundaries: Sequence[float],
    on_describing_visuals: Callable[[], None],
) -> MediaSegment:
    segment_id = f"segment-{uuid7().hex}"
    frames = (
        _extract_event_frames(
            moment,
            media_path,
            asset_directory / FRAMES_DIRECTORY_NAME / segment_id,
            settings,
            scene_boundaries,
        )
        if moment.detailed
        else []
    )
    if describer is not None and frames:
        on_describing_visuals()
    visual_description = _describe_event(moment, frames, describer, strategy)
    transcript_text = moment.transcript_text or None
    return MediaSegment(
        segment_id=segment_id,
        asset_id=asset_id,
        start_seconds=moment.start_seconds,
        end_seconds=moment.end_seconds,
        title=_event_title(moment),
        detailed_summary=visual_description or transcript_text,
        transcript_text=transcript_text,
        key_frame_paths=[
            _relative_to_asset(asset_directory, frame) for frame in frames
        ],
        visual_description=visual_description,
        marker_ids=list(moment.marker_ids),
    )


def _extract_event_frames(
    moment: TimelineMoment,
    media_path: Path,
    frames_directory: Path,
    settings: Settings,
    scene_boundaries: Sequence[float] = (),
) -> list[Path]:
    duration = max(moment.end_seconds - moment.start_seconds, 0.1)
    scene_points = [
        boundary
        for boundary in scene_boundaries
        if moment.start_seconds < boundary < moment.end_seconds
    ]
    frame_count = max(
        MIN_CHAPTER_FRAME_COUNT,
        min(
            MAX_CHAPTER_FRAME_COUNT,
            round(duration / SECONDS_PER_ADAPTIVE_FRAME) + len(scene_points) + 1,
        ),
    )
    contextual_time_points = [
        moment.start_seconds + duration * (index + 0.5) / frame_count
        for index in range(frame_count)
    ]
    marker_time_points = [
        influence.anchor_seconds
        for influence in moment.marker_influences
        if moment.start_seconds <= influence.anchor_seconds <= moment.end_seconds
    ]
    time_points = sorted(
        dict.fromkeys((*contextual_time_points, *scene_points, *marker_time_points))
    )
    try:
        return extract_frames(
            media_path,
            time_points,
            frames_directory,
            settings.ffmpeg_path,
            settings.ffmpeg_bin_dir,
        )
    except FrameExtractionError:
        return []


def _describe_event(
    moment: TimelineMoment,
    frames: list[Path],
    describer: VisionDescriber | None,
    strategy: AnalysisStrategy,
) -> str | None:
    if describer is None or not frames:
        return None
    try:
        return describer.describe(frames, _analysis_prompt(moment, strategy))
    except VisionDescriptionError:
        return None


def _analysis_prompt(moment: TimelineMoment, strategy: AnalysisStrategy) -> str:
    transcript = moment.transcript_text[:MAX_PROMPT_TRANSCRIPT_CHARACTERS]
    weights = strategy.weights
    emphasis = ""
    if weights is not None:
        weighted_topics = sorted(
            (
                (weights.core_concepts, "核心概念"),
                (weights.formula_derivation, "公式推导"),
                (weights.case_demonstration, "案例演示"),
                (weights.questions_conclusions, "疑问与结论"),
                (weights.visual_content, "视觉内容"),
            ),
            reverse=True,
        )[:3]
        emphasis = "、".join(topic for _, topic in weighted_topics)
    marker_context = ""
    if moment.marker_influences:
        marker_lines = [
            _marker_influence_prompt(influence)
            for influence in moment.marker_influences
        ]
        marker_context = "\n标记范围权重：" + "；".join(marker_lines)
    return (
        "你正在分析同一视频片段按时间排列的多张画面。"
        f"分析目标：总结这段课程讲解的主题、过程和结论。策略优先关注：{emphasis or '核心内容'}。"
        "请结合转写、画面文字（OCR）和视觉变化，用中文输出一段可复习的详细笔记；"
        "区分视频明确表达的内容与合理推断，不得补造事实。"
        f"{marker_context}"
        f"\n转写：{transcript or '该片段没有可用转写，请只依据画面。'}"
    )


def _marker_influence_prompt(influence: MarkerInfluence) -> str:
    if influence.focus_end_seconds > influence.focus_start_seconds:
        marker_position = (
            f"范围标记 {influence.focus_start_seconds:.1f}–"
            f"{influence.focus_end_seconds:.1f} 秒，"
        )
    else:
        marker_position = f"标记 {influence.anchor_seconds:.1f} 秒，"
    return (
        f"{marker_position}"
        f"重要程度 {influence.importance}/5，"
        f"有效向前 {influence.range_before_seconds:.1f} 秒、"
        f"向后 {influence.range_after_seconds:.1f} 秒，"
        f"本事件权重 {influence.event_weight:.2f}"
    )


def _event_title(moment: TimelineMoment) -> str:
    text = moment.transcript_text.strip()
    if not text:
        return "无转写事件"
    first_sentence = text.split("。", 1)[0].split("！", 1)[0].split("？", 1)[0]
    return first_sentence[:TITLE_MAX_CHARACTERS]


def _relative_to_asset(asset_directory: Path, frame_path: Path) -> str:
    return frame_path.relative_to(asset_directory).as_posix()
