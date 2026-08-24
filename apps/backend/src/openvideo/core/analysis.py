"""把带时间戳转写组织为可回跳的时间轴事件。"""

from __future__ import annotations

import math
from dataclasses import dataclass

from openvideo.core.analysis_models import (
    AnalysisDepth,
    AnalysisMode,
    AnalysisStrategy,
    Transcript,
    TranscriptSegment,
)
from openvideo.core.models import MediaMarker


MAX_EVENT_DURATION_SECONDS = 180.0
MIN_SCENE_SPLIT_DURATION_SECONDS = 45.0
SPEECH_GAP_SECONDS = 8.0


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
    if mode == AnalysisMode.MARKERS:
        moments = _marker_moments(
            transcript.segments,
            markers,
            duration_seconds,
            scene_boundaries or [],
            resolved_strategy.marker_context_seconds,
        )
    else:
        moments = _full_timeline_moments(transcript.segments, scene_boundaries or [])
        moments = _attach_markers(
            moments,
            transcript.segments,
            markers,
            duration_seconds,
            scene_boundaries or [],
            resolved_strategy.marker_context_seconds,
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
    if moment.marker_ids:
        score += weights.user_markers
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
    transcript_segments: list[TranscriptSegment],
    markers: list[MediaMarker],
    duration_seconds: float | None,
    scene_boundaries: list[float],
    marker_context_seconds: float,
) -> list[TimelineMoment]:
    moments = [
        _moment_around_marker(
            transcript_segments,
            marker,
            duration_seconds,
            scene_boundaries,
            marker_context_seconds,
        )
        for marker in sorted(markers, key=lambda item: item.time_seconds)
    ]
    merged: list[TimelineMoment] = []
    for moment in moments:
        if merged and moment.start_seconds <= merged[-1].end_seconds:
            merged[-1] = _merge_marker_moments(merged[-1], moment)
        else:
            merged.append(moment)
    return merged


def _moment_around_marker(
    transcript_segments: list[TranscriptSegment],
    marker: MediaMarker,
    duration_seconds: float | None,
    scene_boundaries: list[float],
    marker_context_seconds: float,
) -> TimelineMoment:
    requested_start = max(0.0, marker.time_seconds - marker_context_seconds)
    requested_end = marker.time_seconds + marker_context_seconds
    if duration_seconds is not None:
        requested_end = min(requested_end, duration_seconds)
    previous_boundaries = [
        boundary
        for boundary in scene_boundaries
        if requested_start <= boundary <= marker.time_seconds
    ]
    next_boundaries = [
        boundary
        for boundary in scene_boundaries
        if marker.time_seconds < boundary <= requested_end
    ]
    if previous_boundaries:
        requested_start = max(previous_boundaries)
    if next_boundaries:
        requested_end = min(next_boundaries)
    selected = [
        segment
        for segment in transcript_segments
        if segment.end_seconds >= requested_start and segment.start_seconds <= requested_end
    ]
    if not selected:
        return TimelineMoment(
            start_seconds=requested_start,
            end_seconds=max(requested_end, requested_start + 0.1),
            transcript_text="",
            marker_ids=(marker.marker_id,),
            tags=tuple(dict.fromkeys(marker.tags)),
        )
    return TimelineMoment(
        start_seconds=selected[0].start_seconds,
        end_seconds=selected[-1].end_seconds,
        transcript_text=_merge_text(selected),
        marker_ids=(marker.marker_id,),
        tags=tuple(dict.fromkeys(marker.tags)),
    )


def _merge_marker_moments(left: TimelineMoment, right: TimelineMoment) -> TimelineMoment:
    texts = [text for text in (left.transcript_text, right.transcript_text) if text]
    return TimelineMoment(
        start_seconds=min(left.start_seconds, right.start_seconds),
        end_seconds=max(left.end_seconds, right.end_seconds),
        transcript_text=" ".join(dict.fromkeys(texts)),
        marker_ids=tuple(dict.fromkeys((*left.marker_ids, *right.marker_ids))),
        tags=tuple(dict.fromkeys((*left.tags, *right.tags))),
    )


def _attach_markers(
    moments: list[TimelineMoment],
    transcript_segments: list[TranscriptSegment],
    markers: list[MediaMarker],
    duration_seconds: float | None,
    scene_boundaries: list[float],
    marker_context_seconds: float,
) -> list[TimelineMoment]:
    resolved = list(moments)
    for marker in markers:
        matching_index = next(
            (
                index
                for index, moment in enumerate(resolved)
                if moment.start_seconds <= marker.time_seconds <= moment.end_seconds
            ),
            None,
        )
        if matching_index is None:
            resolved.append(
                _moment_around_marker(
                    transcript_segments,
                    marker,
                    duration_seconds,
                    scene_boundaries,
                    marker_context_seconds,
                )
            )
            continue
        moment = resolved[matching_index]
        resolved[matching_index] = TimelineMoment(
            **{
                **moment.__dict__,
                "marker_ids": tuple(dict.fromkeys((*moment.marker_ids, marker.marker_id))),
                "tags": tuple(dict.fromkeys((*moment.tags, *marker.tags))),
            }
        )
    return sorted(resolved, key=lambda moment: moment.start_seconds)


def _moment_from_segments(segments: list[TranscriptSegment]) -> TimelineMoment:
    return TimelineMoment(
        start_seconds=segments[0].start_seconds,
        end_seconds=segments[-1].end_seconds,
        transcript_text=_merge_text(segments),
    )


def _merge_text(segments: list[TranscriptSegment]) -> str:
    return " ".join(segment.text.strip() for segment in segments if segment.text.strip())
