from pathlib import Path
from types import SimpleNamespace

from openvideo.core.analysis import MarkerInfluence, TimelineMoment
from openvideo.core.analysis_models import AnalysisStrategy
from openvideo.tools.analysis_pipeline import _analysis_prompt, _extract_event_frames


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

    assert captured_time_points == [2, 5, 8, 4]


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
                event_weight=0.75,
            ),
        ),
    )

    prompt = _analysis_prompt(moment, AnalysisStrategy())

    assert "标记 4.0 秒" in prompt
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
                event_weight=1,
            ),
        ),
    )

    prompt = _analysis_prompt(moment, AnalysisStrategy())

    assert "范围标记 5.0–15.0 秒" in prompt
