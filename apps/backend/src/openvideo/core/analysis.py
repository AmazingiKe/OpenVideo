"""把带时间戳转写组织为可回跳的时间轴事件。"""

from __future__ import annotations

import math
from dataclasses import dataclass

from openvideo.core.analysis_models import (
    AnalysisDepth,
    AnalysisMode,
    AnalysisStrategy,
)
from openvideo.core.media_models import MediaMarker
from openvideo.core.transcription_models import Transcript, TranscriptSegment


MAX_EVENT_DURATION_SECONDS = 180.0
MIN_SCENE_SPLIT_DURATION_SECONDS = 45.0
SPEECH_GAP_SECONDS = 8.0


@dataclass(frozen=True)
class MarkerInfluence:
    """记录事件受单个标记影响的实际范围，让排序和 AI 提示共享同一依据。"""

    marker_id: str
    anchor_seconds: float
    range_before_seconds: float
    range_after_seconds: float
    event_weight: float


@dataclass(frozen=True)
class TimelineMoment:
    """时间轴事件保留生成笔记所需的证据范围与用户意图。"""

    start_seconds: float
    end_seconds: float
    transcript_text: str
    marker_ids: tuple[str, ...] = ()
    tags: tuple[str, ...] = ()
    content_type: str = "core_concepts"
    priority: float = 0
    detailed: bool = True
    marker_weight: float = 0
    marker_influences: tuple[MarkerInfluence, ...] = ()


def select_timeline_moments(
    transcript: Transcript,
    mode: AnalysisMode,
    markers: list[MediaMarker],
    duration_seconds: float | None,
    scene_boundaries: list[float] | None = None,
    strategy: AnalysisStrategy | None = None,
) -> list[TimelineMoment]:
    """全片按内容边界建事件；标记模式只保留用户主动关注的上下文。"""
    resolved_strategy = strategy or AnalysisStrategy()
    moments = _full_timeline_moments(transcript.segments, scene_boundaries or [])
    moments = _attach_markers(
        moments,
        markers,
        duration_seconds,
        resolved_strategy,
    )
    if mode == AnalysisMode.MARKERS:
        moments = _marker_moments(
            moments,
            markers,
            duration_seconds,
            resolved_strategy,
        )
    return prioritize_timeline_moments(moments, resolved_strategy)


def prioritize_timeline_moments(
    moments: list[TimelineMoment],
    strategy: AnalysisStrategy,
) -> list[TimelineMoment]:
    """覆盖率只控制详细视觉分析，所有候选仍按时间顺序保留文本事件。"""
    if not moments:
        return []
    ranked = [_score_moment(moment, strategy) for moment in moments]
    coverage = {
        AnalysisDepth.QUICK: 0.4,
        AnalysisDepth.BALANCED: 0.7,
        AnalysisDepth.DEEP: 1.0,
    }[strategy.depth]
    detailed_count = math.ceil(len(ranked) * coverage)
    selected = {
        index
        for index, _ in sorted(
            enumerate(ranked),
            key=lambda item: item[1].priority,
            reverse=True,
        )[:detailed_count]
    }
    selected.update(index for index, moment in enumerate(ranked) if moment.marker_ids)
    return [
        TimelineMoment(**{**moment.__dict__, "detailed": index in selected})
        for index, moment in enumerate(ranked)
    ]


def _score_moment(moment: TimelineMoment, strategy: AnalysisStrategy) -> TimelineMoment:
    content_type = _classify_content(moment)
    weights = strategy.weights
    if weights is None:
        raise ValueError("分析策略权重尚未解析")
    score = float(getattr(weights, content_type))
    score += weights.user_markers * moment.marker_weight
    if moment.tags:
        score += min(len(moment.tags) * 5, 20)
    return TimelineMoment(
        **{
            **moment.__dict__,
            "content_type": content_type,
            "priority": score,
        }
    )


def _classify_content(moment: TimelineMoment) -> str:
    combined = f"{moment.transcript_text} {' '.join(moment.tags)}".lower()
    signals = (
        ("formula_derivation", ("公式", "推导", "等于", "方程", "theorem", "proof", "=")),
        ("case_demonstration", ("案例", "示例", "例如", "演示", "操作", "步骤", "demo")),
        ("questions_conclusions", ("疑问", "问题", "结论", "总结", "因此", "为什么", "?", "？")),
        ("visual_content", ("画面", "图表", "界面", "这里可以看到", "如图")),
    )
    return next(
        (content_type for content_type, keywords in signals if any(keyword in combined for keyword in keywords)),
        "core_concepts",
    )


def _full_timeline_moments(
    segments: list[TranscriptSegment],
    scene_boundaries: list[float],
) -> list[TimelineMoment]:
    if not segments:
        return []
    groups: list[list[TranscriptSegment]] = []
    current: list[TranscriptSegment] = []
    for segment in segments:
        if current and _starts_new_event(current, segment, scene_boundaries):
            groups.append(current)
            current = []
        current.append(segment)
    if current:
        groups.append(current)
    return [_moment_from_segments(group) for group in groups]


def _starts_new_event(
    current: list[TranscriptSegment],
    next_segment: TranscriptSegment,
    scene_boundaries: list[float],
) -> bool:
    event_start = current[0].start_seconds
    previous_end = current[-1].end_seconds
    if next_segment.start_seconds - previous_end >= SPEECH_GAP_SECONDS:
        return True
    event_duration = next_segment.end_seconds - event_start
    if event_duration >= MAX_EVENT_DURATION_SECONDS:
        return True
    if event_duration < MIN_SCENE_SPLIT_DURATION_SECONDS:
        return False
    previous_start = current[-1].start_seconds
    return any(previous_start < boundary <= next_segment.start_seconds for boundary in scene_boundaries)


def _marker_moments(
    moments: list[TimelineMoment],
    markers: list[MediaMarker],
    duration_seconds: float | None,
    strategy: AnalysisStrategy,
) -> list[TimelineMoment]:
    selected = [moment for moment in moments if moment.marker_influences]
    represented_marker_ids = {
        influence.marker_id
        for moment in selected
        for influence in moment.marker_influences
    }
    selected.extend(
        _fallback_marker_moment(marker, duration_seconds, strategy)
        for marker in markers
        if marker.marker_id not in represented_marker_ids
    )
    return sorted(selected, key=lambda moment: moment.start_seconds)


def _fallback_marker_moment(
    marker: MediaMarker,
    duration_seconds: float | None,
    strategy: AnalysisStrategy,
) -> TimelineMoment:
    range_start, range_end, before_seconds, after_seconds = _resolved_marker_range(
        marker, strategy, duration_seconds
    )
    if range_end <= range_start:
        range_start = max(0.0, marker.start_seconds - 0.1)
        range_end = max(marker.start_seconds, range_start + 0.1)
    influence = MarkerInfluence(
        marker_id=marker.marker_id,
        anchor_seconds=marker.start_seconds,
        range_before_seconds=before_seconds,
        range_after_seconds=after_seconds,
        event_weight=1,
    )
    return TimelineMoment(
        start_seconds=range_start,
        end_seconds=range_end,
        transcript_text="",
        marker_ids=(marker.marker_id,),
        tags=tuple(dict.fromkeys(marker.tags)),
        marker_weight=1,
        marker_influences=(influence,),
    )


def _attach_markers(
    moments: list[TimelineMoment],
    markers: list[MediaMarker],
    duration_seconds: float | None,
    strategy: AnalysisStrategy,
) -> list[TimelineMoment]:
    resolved: list[TimelineMoment] = []
    for moment in moments:
        influences = tuple(
            influence
            for marker in markers
            if (
                influence := _marker_influence_for_moment(
                    moment, marker, strategy, duration_seconds
                )
            )
            is not None
        )
        marker_ids = tuple(influence.marker_id for influence in influences)
        influencing_ids = set(marker_ids)
        tags = tuple(
            dict.fromkeys(
                tag
                for marker in markers
                if marker.marker_id in influencing_ids
                for tag in marker.tags
            )
        )
        resolved.append(
            TimelineMoment(
                **{
                    **moment.__dict__,
                    "marker_ids": marker_ids,
                    "tags": tags,
                    "marker_weight": max(
                        (influence.event_weight for influence in influences),
                        default=0,
                    ),
                    "marker_influences": influences,
                }
            )
        )
    return resolved


def _marker_influence_for_moment(
    moment: TimelineMoment,
    marker: MediaMarker,
    strategy: AnalysisStrategy,
    duration_seconds: float | None,
) -> MarkerInfluence | None:
    range_start, range_end, before_seconds, after_seconds = _resolved_marker_range(
        marker, strategy, duration_seconds
    )
    anchor_seconds = (
        marker.start_seconds
        if marker.end_seconds is None
        else (marker.start_seconds + marker.end_seconds) / 2
    )
    contains_marker = moment.start_seconds <= anchor_seconds <= moment.end_seconds
    overlaps_range = moment.end_seconds > range_start and moment.start_seconds < range_end
    if not contains_marker and not overlaps_range:
        return None
    if contains_marker:
        event_weight = 1.0
    elif moment.end_seconds < anchor_seconds:
        event_weight = max(
            0.0,
            1 - (anchor_seconds - moment.end_seconds) / max(before_seconds, 0.1),
        )
    else:
        event_weight = max(
            0.0,
            1 - (moment.start_seconds - anchor_seconds) / max(after_seconds, 0.1),
        )
    if event_weight <= 0:
        return None
    return MarkerInfluence(
        marker_id=marker.marker_id,
        anchor_seconds=anchor_seconds,
        range_before_seconds=before_seconds,
        range_after_seconds=after_seconds,
        event_weight=event_weight,
    )


def _resolved_marker_range(
    marker: MediaMarker,
    strategy: AnalysisStrategy,
    duration_seconds: float | None,
) -> tuple[float, float, float, float]:
    if marker.end_seconds is not None:
        anchor_seconds = (marker.start_seconds + marker.end_seconds) / 2
        return (
            marker.start_seconds,
            marker.end_seconds,
            anchor_seconds - marker.start_seconds,
            marker.end_seconds - anchor_seconds,
        )
    requested_before = strategy.marker_range_before_seconds
    requested_after = strategy.marker_range_after_seconds
    range_start = max(0.0, marker.start_seconds - requested_before)
    range_end = marker.start_seconds + requested_after
    if duration_seconds is not None:
        range_end = min(range_end, duration_seconds)
    return (
        range_start,
        range_end,
        marker.start_seconds - range_start,
        max(0.0, range_end - marker.start_seconds),
    )


def _moment_from_segments(segments: list[TranscriptSegment]) -> TimelineMoment:
    return TimelineMoment(
        start_seconds=segments[0].start_seconds,
        end_seconds=segments[-1].end_seconds,
        transcript_text=_merge_text(segments),
    )


def _merge_text(segments: list[TranscriptSegment]) -> str:
    return " ".join(segment.text.strip() for segment in segments if segment.text.strip())
