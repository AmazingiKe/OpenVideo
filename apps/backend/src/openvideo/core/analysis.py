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


SPEECH_GAP_SECONDS = 8.0
SEMANTIC_TRANSITION_PREFIXES = (
    "接下来",
    "下面",
    "然后我们",
    "现在来看",
    "最后",
    "总结一下",
    "第二",
    "第三",
    "next",
    "now let's",
    "finally",
    "in summary",
)


@dataclass(frozen=True)
class MarkerInfluence:
    """记录事件受单个标记影响的实际范围，让排序和 AI 提示共享同一依据。"""

    marker_id: str
    anchor_seconds: float
    focus_start_seconds: float
    focus_end_seconds: float
    range_before_seconds: float
    range_after_seconds: float
    importance: int
    event_weight: float


@dataclass(frozen=True)
class TimelineMoment:
    """时间轴事件保留生成笔记所需的证据范围与用户意图。"""

    start_seconds: float
    end_seconds: float
    transcript_text: str
    marker_ids: tuple[str, ...] = ()
    content_type: str = "core_concepts"
    priority: float = 0
    detailed: bool = True
    marker_weight: float = 0
    marker_influences: tuple[MarkerInfluence, ...] = ()


@dataclass(frozen=True)
class SemanticChapter:
    """章节边界引用字幕索引，避免内部窗口时间成为最终事件边界。"""

    start_index: int
    end_index: int
    title: str = ""


def select_timeline_moments(
    transcript: Transcript,
    mode: AnalysisMode,
    markers: list[MediaMarker],
    duration_seconds: float | None,
    scene_boundaries: list[float] | None = None,
    strategy: AnalysisStrategy | None = None,
    semantic_chapters: list[SemanticChapter] | None = None,
) -> list[TimelineMoment]:
    """全片按内容边界建事件；标记模式只保留用户主动关注的上下文。"""
    resolved_strategy = strategy or AnalysisStrategy()
    if mode == AnalysisMode.MARKERS:
        moments = _precise_marker_moments(
            transcript.segments,
            markers,
            duration_seconds,
            resolved_strategy,
        )
        return prioritize_timeline_moments(moments, resolved_strategy)
    moments = _full_timeline_moments(
        transcript.segments,
        scene_boundaries or [],
        semantic_chapters,
    )
    moments = _attach_markers(
        moments,
        markers,
        duration_seconds,
        resolved_strategy,
    )
    return prioritize_timeline_moments(moments, resolved_strategy)


def _precise_marker_moments(
    segments: list[TranscriptSegment],
    markers: list[MediaMarker],
    duration_seconds: float | None,
    strategy: AnalysisStrategy,
) -> list[TimelineMoment]:
    """点标记取全局上下文，范围标记保持用户明确划定的边界。"""

    moments: list[TimelineMoment] = []
    for marker in sorted(markers, key=lambda item: item.start_seconds):
        focus_start = marker.start_seconds
        focus_end = (
            marker.end_seconds if marker.end_seconds is not None else focus_start
        )
        if marker.end_seconds is None:
            range_start = max(0, focus_start - strategy.marker_range_before_seconds)
            range_end = focus_end + strategy.marker_range_after_seconds
            if duration_seconds is not None:
                range_end = min(range_end, duration_seconds)
            before_seconds = focus_start - range_start
            after_seconds = max(0, range_end - focus_end)
        else:
            range_start = focus_start
            range_end = focus_end
            before_seconds = 0
            after_seconds = 0
        matching = [
            segment
            for segment in segments
            if segment.end_seconds >= range_start and segment.start_seconds <= range_end
        ]
        influence = MarkerInfluence(
            marker_id=marker.marker_id,
            anchor_seconds=(focus_start + focus_end) / 2,
            focus_start_seconds=focus_start,
            focus_end_seconds=focus_end,
            range_before_seconds=before_seconds,
            range_after_seconds=after_seconds,
            importance=marker.importance,
            event_weight=marker.importance / 5,
        )
        moments.append(
            TimelineMoment(
                start_seconds=range_start,
                end_seconds=max(range_end, range_start + 0.1),
                transcript_text=_merge_text(matching),
                marker_ids=(marker.marker_id,),
                marker_weight=influence.event_weight,
                marker_influences=(influence,),
            )
        )
    return moments


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
    content_weights = {
        "core_concepts": weights.core_concepts,
        "formula_derivation": weights.formula_derivation,
        "case_demonstration": weights.case_demonstration,
        "questions_conclusions": weights.questions_conclusions,
        "visual_content": weights.visual_content,
    }
    score = float(content_weights[content_type])
    score += weights.user_markers * moment.marker_weight
    return TimelineMoment(
        **{
            **moment.__dict__,
            "content_type": content_type,
            "priority": score,
        }
    )


def _classify_content(moment: TimelineMoment) -> str:
    combined = moment.transcript_text.lower()
    signals = (
        (
            "formula_derivation",
            ("公式", "推导", "等于", "方程", "theorem", "proof", "="),
        ),
        (
            "case_demonstration",
            ("案例", "示例", "例如", "演示", "操作", "步骤", "demo"),
        ),
        (
            "questions_conclusions",
            ("疑问", "问题", "结论", "总结", "因此", "为什么", "?", "？"),
        ),
        ("visual_content", ("画面", "图表", "界面", "这里可以看到", "如图")),
    )
    return next(
        (
            content_type
            for content_type, keywords in signals
            if any(keyword in combined for keyword in keywords)
        ),
        "core_concepts",
    )


def _full_timeline_moments(
    segments: list[TranscriptSegment],
    scene_boundaries: list[float],
    semantic_chapters: list[SemanticChapter] | None = None,
) -> list[TimelineMoment]:
    if not segments:
        return []
    if semantic_chapters:
        return [
            _moment_from_segments(segments[chapter.start_index : chapter.end_index + 1])
            for chapter in semantic_chapters
        ]
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
    previous_end = current[-1].end_seconds
    if next_segment.start_seconds - previous_end >= SPEECH_GAP_SECONDS:
        return True
    normalized_text = next_segment.text.casefold().lstrip(" ，。！？,.!?:：")
    if not normalized_text.startswith(SEMANTIC_TRANSITION_PREFIXES):
        return False
    previous_start = current[-1].start_seconds
    scene_changed = any(
        previous_start < boundary <= next_segment.start_seconds
        for boundary in scene_boundaries
    )
    return scene_changed or len(current) >= 2


def merge_semantic_chapter_candidates(
    segment_count: int,
    candidates: list[SemanticChapter],
) -> list[SemanticChapter]:
    """把重叠窗口候选归并为一次覆盖全片且互不重叠的最终章节。"""

    if segment_count <= 0:
        return []
    valid = [
        chapter
        for chapter in candidates
        if 0 <= chapter.start_index <= chapter.end_index < segment_count
    ]
    starts: list[tuple[int, str]] = [(0, valid[0].title if valid else "")]
    for chapter in sorted(valid, key=lambda item: (item.start_index, item.end_index)):
        if chapter.start_index == 0:
            continue
        if starts and chapter.start_index == starts[-1][0]:
            if not starts[-1][1] and chapter.title:
                starts[-1] = (starts[-1][0], chapter.title)
            continue
        starts.append((chapter.start_index, chapter.title))
    chapters = [
        SemanticChapter(
            start_index=start,
            end_index=(
                starts[index + 1][0] - 1
                if index + 1 < len(starts)
                else segment_count - 1
            ),
            title=title,
        )
        for index, (start, title) in enumerate(starts)
    ]
    return [chapter for chapter in chapters if chapter.start_index <= chapter.end_index]


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
        resolved.append(
            TimelineMoment(
                **{
                    **moment.__dict__,
                    "marker_ids": marker_ids,
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
    (
        range_start,
        range_end,
        focus_start,
        focus_end,
        before_seconds,
        after_seconds,
    ) = _resolved_marker_range(marker, strategy, duration_seconds)
    anchor_seconds = (focus_start + focus_end) / 2
    contains_marker = (
        moment.end_seconds >= focus_start and moment.start_seconds <= focus_end
    )
    overlaps_range = (
        moment.end_seconds > range_start and moment.start_seconds < range_end
    )
    if not contains_marker and not overlaps_range:
        return None
    if contains_marker:
        distance_weight = 1.0
    elif moment.end_seconds < focus_start:
        distance_weight = _linear_marker_weight(
            focus_start - moment.end_seconds,
            before_seconds,
        )
    else:
        distance_weight = _linear_marker_weight(
            moment.start_seconds - focus_end,
            after_seconds,
        )
    event_weight = distance_weight * marker.importance / 5
    return MarkerInfluence(
        marker_id=marker.marker_id,
        anchor_seconds=anchor_seconds,
        focus_start_seconds=focus_start,
        focus_end_seconds=focus_end,
        range_before_seconds=before_seconds,
        range_after_seconds=after_seconds,
        importance=marker.importance,
        event_weight=event_weight,
    )


def _linear_marker_weight(distance_seconds: float, range_seconds: float) -> float:
    if range_seconds <= 0:
        return 0.0
    return max(0.0, 1 - distance_seconds / range_seconds)


def _resolved_marker_range(
    marker: MediaMarker,
    strategy: AnalysisStrategy,
    duration_seconds: float | None,
) -> tuple[float, float, float, float, float, float]:
    focus_start = marker.start_seconds
    focus_end = (
        marker.end_seconds if marker.end_seconds is not None else marker.start_seconds
    )
    if marker.end_seconds is None:
        requested_before = strategy.marker_range_before_seconds
        requested_after = strategy.marker_range_after_seconds
    else:
        requested_before = 0
        requested_after = 0
    range_start = max(0.0, focus_start - requested_before)
    range_end = focus_end + requested_after
    if duration_seconds is not None:
        range_end = min(range_end, duration_seconds)
    return (
        range_start,
        range_end,
        focus_start,
        focus_end,
        focus_start - range_start,
        max(0.0, range_end - focus_end),
    )


def _moment_from_segments(segments: list[TranscriptSegment]) -> TimelineMoment:
    return TimelineMoment(
        start_seconds=segments[0].start_seconds,
        end_seconds=segments[-1].end_seconds,
        transcript_text=_merge_text(segments),
    )


def _merge_text(segments: list[TranscriptSegment]) -> str:
    return " ".join(
        segment.text.strip() for segment in segments if segment.text.strip()
    )
