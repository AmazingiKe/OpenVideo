"""把带时间戳转写组织为可回跳的时间轴事件。"""

from __future__ import annotations

from dataclasses import dataclass

from openvideo.core.analysis_models import AnalysisMode, Transcript, TranscriptSegment
from openvideo.core.models import MediaMarker


MARKER_CONTEXT_SECONDS = 30.0
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


def select_timeline_moments(
    transcript: Transcript,
    mode: AnalysisMode,
    markers: list[MediaMarker],
    duration_seconds: float | None,
    scene_boundaries: list[float] | None = None,
) -> list[TimelineMoment]:
    """全片按内容边界建事件；标记模式只保留用户主动关注的上下文。"""
    if mode == AnalysisMode.MARKERS:
        return _marker_moments(
            transcript.segments,
            markers,
            duration_seconds,
            scene_boundaries or [],
        )
    return _full_timeline_moments(transcript.segments, scene_boundaries or [])


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
) -> list[TimelineMoment]:
    moments = [
        _moment_around_marker(transcript_segments, marker, duration_seconds, scene_boundaries)
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
) -> TimelineMoment:
    requested_start = max(0.0, marker.time_seconds - MARKER_CONTEXT_SECONDS)
    requested_end = marker.time_seconds + MARKER_CONTEXT_SECONDS
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


def _moment_from_segments(segments: list[TranscriptSegment]) -> TimelineMoment:
    return TimelineMoment(
        start_seconds=segments[0].start_seconds,
        end_seconds=segments[-1].end_seconds,
        transcript_text=_merge_text(segments),
    )


def _merge_text(segments: list[TranscriptSegment]) -> str:
    return " ".join(segment.text.strip() for segment in segments if segment.text.strip())
