from pathlib import Path
from types import SimpleNamespace

import pytest

from openvideo.core.analysis import MarkerInfluence, TimelineMoment
from openvideo.core.analysis_models import AnalysisDepth, AnalysisStrategy
from openvideo.core.identifiers import uuid7
from openvideo.core.media_models import VisualAnalysisStatus
from openvideo.core.transcription_models import Transcript, TranscriptSegment
from openvideo.tools.analysis_pipeline import (
    MAX_CHAPTER_CONTEXT_FRAME_COUNT,
    MAX_CHAPTER_FRAME_COUNT,
    SCENE_FRAME_MARGIN_SECONDS,
    _analysis_prompt,
    _build_segment,
    _extract_event_frames,
    _select_event_frame_times,
    build_segments,
)
from openvideo.tools.vision import VisionDescriptionError


def test_marker_event_frames_include_marker_point_and_context(
    monkeypatch, tmp_path: Path
):
    captured_time_points: list[float] = []

    def capture_frames(
        _media_path,
        time_points,
        _frames_directory,
        _ffmpeg_path,
        _ffmpeg_bin_dir,
    ):
        captured_time_points.extend(time_points)
        return []

    monkeypatch.setattr(
        "openvideo.tools.analysis_pipeline.extract_frames", capture_frames
    )
    moment = TimelineMoment(
        start_seconds=0,
        end_seconds=10,
        transcript_text="正文",
        marker_influences=(
            MarkerInfluence(
                marker_id="marker-0123456789abcdef0123456789abcdef",
                anchor_seconds=4,
                focus_start_seconds=4,
                focus_end_seconds=4,
                range_before_seconds=4,
                range_after_seconds=6,
                importance=5,
                event_weight=1,
            ),
        ),
    )

    _extract_event_frames(
        moment,
        tmp_path / "video.mp4",
        tmp_path / "frames",
        SimpleNamespace(ffmpeg_path=None, ffmpeg_bin_dir=None),
    )

    assert captured_time_points == [2.5, 4, 7.5]


@pytest.mark.parametrize("duration, cut_count", [(120, 119), (300, 294)])
def test_dense_scene_selection_bounds_work_and_covers_the_chapter(
    monkeypatch, tmp_path: Path, duration: float, cut_count: int
):
    requested_times = []

    def capture_frames(_media, time_points, *_args):
        requested_times.extend(time_points)
        return []

    monkeypatch.setattr(
        "openvideo.tools.analysis_pipeline.extract_frames", capture_frames
    )
    boundaries = [
        duration * index / (cut_count + 1) for index in range(1, cut_count + 1)
    ]
    moment = TimelineMoment(start_seconds=0, end_seconds=duration, transcript_text="")
    _extract_event_frames(
        moment,
        tmp_path / "video.mp4",
        tmp_path / "frames",
        SimpleNamespace(ffmpeg_path=None, ffmpeg_bin_dir=None),
        boundaries,
    )

    assert len(requested_times) == MAX_CHAPTER_FRAME_COUNT
    assert requested_times == sorted(set(requested_times))
    assert {int(seconds / duration * 4) for seconds in requested_times} == {0, 1, 2, 3}
    gaps = [
        right - left
        for left, right in zip([0, *requested_times], [*requested_times, duration])
    ]
    assert max(gaps) <= duration / 6
    assert all(
        abs(seconds - boundary) >= SCENE_FRAME_MARGIN_SECONDS - 1e-9
        for seconds in requested_times
        for boundary in boundaries
    )


def test_excess_markers_preserve_highest_priority_and_global_context():
    markers = tuple(
        _marker(
            1 + index / 2, importance=5 if index < 16 else 4, weight=1 - index / 100
        )
        for index in range(20)
    )
    moment = TimelineMoment(
        start_seconds=0,
        end_seconds=120,
        transcript_text="",
        marker_influences=markers,
    )

    selected = _select_event_frame_times(moment, [])
    reversed_moment = TimelineMoment(
        start_seconds=0,
        end_seconds=120,
        transcript_text="",
        marker_influences=tuple(reversed(markers)),
    )

    assert len(selected) == MAX_CHAPTER_CONTEXT_FRAME_COUNT
    assert {marker.anchor_seconds for marker in markers[:8]}.issubset(selected)
    assert {int(seconds / 30) for seconds in selected} == {0, 1, 2, 3}
    assert selected == _select_event_frame_times(reversed_moment, [])


def test_scene_cut_and_endpoint_markers_move_inside_valid_scenes():
    moment = TimelineMoment(
        start_seconds=0,
        end_seconds=10,
        transcript_text="",
        marker_influences=tuple(_marker(seconds) for seconds in [-1, 0, 4, 10, 12]),
    )

    selected = _select_event_frame_times(
        moment, [10, 4, float("nan"), 4, 0, float("inf")]
    )

    assert all(0 < seconds < 10 and seconds != 4 for seconds in selected)
    assert {0.25, 4.25, 9.75}.issubset(selected)


def test_short_scene_keeps_important_marker_with_scaled_boundary_margin():
    moment = TimelineMoment(
        start_seconds=0,
        end_seconds=10,
        transcript_text="",
        marker_influences=(_marker(3),),
    )

    selected = _select_event_frame_times(moment, [3, 3.1, 6])

    assert any(seconds == pytest.approx(3.025) for seconds in selected)
    assert all(seconds not in {0, 3, 3.1, 6, 10} for seconds in selected)


@pytest.mark.parametrize("duration", [0.02, 10, 120, 3_600])
def test_empty_scene_list_still_covers_the_whole_interval(duration: float):
    start_seconds = 20
    moment = TimelineMoment(
        start_seconds=start_seconds,
        end_seconds=start_seconds + duration,
        transcript_text="",
    )

    selected = _select_event_frame_times(moment, [])

    assert 2 <= len(selected) <= MAX_CHAPTER_FRAME_COUNT
    assert all(start_seconds < seconds < moment.end_seconds for seconds in selected)
    assert selected[0] <= start_seconds + duration / 4 + 1e-9
    assert selected[-1] >= start_seconds + duration * 3 / 4 - 1e-9
    gaps = [right - left for left, right in zip(selected, selected[1:])]
    assert max(gaps) == pytest.approx(min(gaps))


def test_sparse_scene_selection_represents_each_scene_without_selecting_cuts():
    moment = TimelineMoment(start_seconds=0, end_seconds=120, transcript_text="")

    selected = _select_event_frame_times(moment, [100, 20, 20])

    assert any(0 < seconds < 20 for seconds in selected)
    assert any(20 < seconds < 100 for seconds in selected)
    assert any(100 < seconds < 120 for seconds in selected)
    assert all(seconds not in {0, 20, 100, 120} for seconds in selected)
    assert selected == _select_event_frame_times(moment, [20, 100])


def test_short_unmarked_scene_is_kept_when_scene_coverage_fits_the_budget():
    moment = TimelineMoment(start_seconds=0, end_seconds=120, transcript_text="")

    selected = _select_event_frame_times(moment, [5, 5.1])

    assert any(0 < seconds < 5 for seconds in selected)
    assert any(5 < seconds < 5.1 for seconds in selected)
    assert any(5.1 < seconds < 120 for seconds in selected)
    assert selected[-1] >= 90


def test_scene_dense_chapter_expands_budget_to_preserve_short_text_scenes():
    boundaries = [float(seconds) for seconds in range(1, 21)]
    moment = TimelineMoment(start_seconds=0, end_seconds=50, transcript_text="")

    selected = _select_event_frame_times(moment, boundaries)

    assert MAX_CHAPTER_CONTEXT_FRAME_COUNT < len(selected) <= MAX_CHAPTER_FRAME_COUNT
    edges = [0, *boundaries, 50]
    assert all(
        any(start < point < end for point in selected)
        for start, end in zip(edges, edges[1:])
    )


def test_nearby_distinct_markers_are_not_suppressed_by_a_fixed_time_gap():
    moment = TimelineMoment(
        start_seconds=0,
        end_seconds=10,
        transcript_text="",
        marker_influences=(_marker(4), _marker(4.02), _marker(4, importance=2)),
    )

    selected = _select_event_frame_times(moment, [])

    assert {4, 4.02}.issubset(selected)
    assert len(selected) == 4


@pytest.mark.parametrize(
    "start,end", [(0, 0), (10, 0), (-1, 10), (float("nan"), 10), (0, float("inf"))]
)
def test_invalid_interval_does_not_schedule_frames(start: float, end: float):
    moment = TimelineMoment(start_seconds=start, end_seconds=end, transcript_text="")

    assert _select_event_frame_times(moment, []) == []


def _marker(
    seconds: float, *, importance: int = 5, weight: float = 1
) -> MarkerInfluence:
    return MarkerInfluence(
        marker_id=f"marker-{uuid7().hex}",
        anchor_seconds=seconds,
        focus_start_seconds=seconds,
        focus_end_seconds=seconds,
        range_before_seconds=0,
        range_after_seconds=0,
        importance=importance,
        event_weight=weight,
    )


def test_analysis_prompt_explains_effective_range_and_event_weight():
    moment = TimelineMoment(
        start_seconds=0,
        end_seconds=10,
        transcript_text="正文",
        marker_influences=(
            MarkerInfluence(
                marker_id="marker-0123456789abcdef0123456789abcdef",
                anchor_seconds=4,
                focus_start_seconds=4,
                focus_end_seconds=4,
                range_before_seconds=4,
                range_after_seconds=6,
                importance=3,
                event_weight=0.75,
            ),
        ),
    )

    prompt = _analysis_prompt(moment, AnalysisStrategy())

    assert "标记 4.0 秒" in prompt
    assert "重要程度 3/5" in prompt
    assert "有效向前 4.0 秒、向后 6.0 秒" in prompt
    assert "本事件权重 0.75" in prompt


def test_analysis_prompt_identifies_range_marker_focus():
    moment = TimelineMoment(
        start_seconds=0,
        end_seconds=20,
        transcript_text="正文",
        marker_influences=(
            MarkerInfluence(
                marker_id="marker-0123456789abcdef0123456789abcdef",
                anchor_seconds=10,
                focus_start_seconds=5,
                focus_end_seconds=15,
                range_before_seconds=5,
                range_after_seconds=5,
                importance=5,
                event_weight=1,
            ),
        ),
    )

    prompt = _analysis_prompt(moment, AnalysisStrategy())

    assert "范围标记 5.0–15.0 秒" in prompt


def test_local_pipeline_attaches_ocr_to_extracted_keyframes(monkeypatch, tmp_path):
    frame_path = tmp_path / "frame.jpg"
    frame_path.write_bytes(b"frame")
    monkeypatch.setattr(
        "openvideo.tools.analysis_pipeline.detect_scene_boundaries",
        lambda *args: [],
    )
    monkeypatch.setattr(
        "openvideo.tools.analysis_pipeline._extract_event_frames",
        lambda *args: [frame_path],
    )
    read_frames = []

    def read_ocr(frame_paths):
        read_frames.extend(frame_paths)
        return "画面公式"

    transcript = Transcript(
        asset_id="01890f4c-7a2b-7cc2-98c4-dc0c0c07398f",
        segments=[
            TranscriptSegment(start_seconds=0, end_seconds=10, text="讲解透视投影")
        ],
    )
    stages = []

    segments = build_segments(
        transcript,
        tmp_path / "video.mp4",
        transcript.asset_id,
        tmp_path,
        10,
        SimpleNamespace(ffmpeg_path=None, ffmpeg_bin_dir=None),
        None,
        [],
        AnalysisStrategy(depth=AnalysisDepth.DEEP),
        lambda stage, progress, message: stages.append(stage),
        ocr_reader=read_ocr,
        formula_reader=lambda _: [r"\hat{a}=\vec{a}/\|\vec{a}\|"],
    )

    assert segments[0].ocr_text == "画面公式"
    assert segments[0].formula_latex == [r"\hat{a}=\vec{a}/\|\vec{a}\|"]
    assert segments[0].visual_description is None
    assert read_frames == [frame_path]
    assert "reading_frame_text" in stages


def test_visual_only_video_is_split_for_keyframe_and_ocr_analysis(
    monkeypatch,
    tmp_path,
):
    frame_path = tmp_path / "frame.jpg"
    frame_path.write_bytes(b"frame")
    monkeypatch.setattr(
        "openvideo.tools.analysis_pipeline.detect_scene_boundaries",
        lambda *args: [],
    )
    monkeypatch.setattr(
        "openvideo.tools.analysis_pipeline._extract_event_frames",
        lambda *args: [frame_path],
    )
    transcript = Transcript(
        asset_id="01890f4c-7a2b-7cc2-98c4-dc0c0c07398f",
        segments=[],
    )

    segments = build_segments(
        transcript,
        tmp_path / "video.mp4",
        transcript.asset_id,
        tmp_path,
        250,
        SimpleNamespace(ffmpeg_path=None, ffmpeg_bin_dir=None),
        None,
        [],
        AnalysisStrategy(depth=AnalysisDepth.DEEP),
        lambda *_: None,
        ocr_reader=lambda _: "画面文字",
    )

    assert [(segment.start_seconds, segment.end_seconds) for segment in segments] == [
        (0, 120),
        (120, 240),
        (240, 250),
    ]
    assert all(segment.title == "画面片段" for segment in segments)
    assert all(segment.key_frame_paths == ["frame.jpg"] for segment in segments)
    assert all(segment.ocr_text == "画面文字" for segment in segments)


@pytest.mark.parametrize(
    "configured,detailed,has_frames,response,expected_status",
    [
        (False, True, True, "画面", VisualAnalysisStatus.NOT_REQUESTED),
        (True, False, True, "画面", VisualAnalysisStatus.SKIPPED),
        (True, True, False, "画面", VisualAnalysisStatus.NO_FRAMES),
        (True, True, True, VisionDescriptionError("失败"), VisualAnalysisStatus.FAILED),
        (True, True, True, " \n ", VisualAnalysisStatus.FAILED),
        (True, True, True, " 节点画面 ", VisualAnalysisStatus.SAMPLED),
    ],
)
def test_segment_preserves_visual_outcome_without_losing_transcript(
    monkeypatch, tmp_path, configured, detailed, has_frames, response, expected_status
):
    frame = tmp_path / "frame.jpg"
    calls = []

    def describe(frames, prompt):
        calls.append((frames, prompt))
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(
        "openvideo.tools.analysis_pipeline._extract_event_frames",
        lambda *_: [frame] if has_frames else [],
    )
    segment = _build_segment(
        TimelineMoment(
            start_seconds=0,
            end_seconds=10,
            transcript_text="连接雾效材质节点",
            detailed=detailed,
        ),
        tmp_path / "video.mp4",
        "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f",
        tmp_path,
        SimpleNamespace(ffmpeg_path=None, ffmpeg_bin_dir=None),
        SimpleNamespace(describe=describe) if configured else None,
        AnalysisStrategy(),
        [],
        None,
        None,
        lambda: None,
        lambda: None,
    )

    assert segment.transcript_text == "连接雾效材质节点"
    assert segment.visual_analysis_status == expected_status
    if expected_status == VisualAnalysisStatus.SAMPLED:
        assert segment.visual_description == "节点画面"
        assert "抽样关键帧" in calls[0][1]
        assert "节点连接、参数数值和操作步骤必须标明无法确认" in calls[0][1]
    else:
        assert segment.visual_description is None
    assert bool(calls) == (configured and detailed and has_frames)
