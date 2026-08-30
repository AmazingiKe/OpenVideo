from pathlib import Path
from types import SimpleNamespace

from openvideo.core.analysis import MarkerInfluence, TimelineMoment
from openvideo.core.analysis_models import AnalysisDepth, AnalysisStrategy
from openvideo.core.transcription_models import Transcript, TranscriptSegment
from openvideo.tools.analysis_pipeline import (
    _analysis_prompt,
    _extract_event_frames,
    build_segments,
)


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

    assert [
        (segment.start_seconds, segment.end_seconds) for segment in segments
    ] == [(0, 120), (120, 240), (240, 250)]
    assert all(segment.title == "画面片段" for segment in segments)
    assert all(segment.key_frame_paths == ["frame.jpg"] for segment in segments)
    assert all(segment.ocr_text == "画面文字" for segment in segments)
