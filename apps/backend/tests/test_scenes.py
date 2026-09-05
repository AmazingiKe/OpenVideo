import re
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from openvideo.core.analysis import TimelineMoment
from openvideo.tools.analysis_pipeline import _select_event_frame_times
from openvideo.tools.frames import extract_frames
from openvideo.tools.media import resolve_tool
from openvideo.tools.scenes import detect_scene_boundaries, refine_scene_candidates


@pytest.fixture
def scene_video(tmp_path: Path):
    ffmpeg = resolve_tool(None, "ffmpeg")
    if ffmpeg is None:
        pytest.skip("未找到 ffmpeg")
    video = tmp_path / "scenes.mp4"
    subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=black:s=64x64:r=30:d=1[a];"
            "color=white:s=64x64:r=30:d=0.1[b];"
            "color=black:s=64x64:r=30:d=1[c];"
            "[a][b][c]concat=n=3:v=1:a=0",
            "-c:v",
            "mpeg4",
            "-g",
            "1",
            str(video),
        ],
        capture_output=True,
        check=True,
        timeout=30,
    )
    return video, ffmpeg


def test_scene_metadata_preserves_real_ffmpeg_cut_times(scene_video):
    video, ffmpeg = scene_video
    result = subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-i",
            str(video),
            "-an",
            "-vf",
            "scale=320:-1,select='gt(scene,0.4)',showinfo",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        check=True,
        text=True,
        timeout=30,
    )
    baseline = [
        float(value) for value in re.findall(r"pts_time:(\d+(?:\.\d+)?)", result.stderr)
    ]

    assert baseline == pytest.approx([1, 1.1])
    assert detect_scene_boundaries(video, ffmpeg) == baseline


def test_budgeted_sampling_preserves_a_three_frame_scene_in_real_pixels(
    scene_video, tmp_path: Path
):
    video, ffmpeg = scene_video
    boundaries = detect_scene_boundaries(video, ffmpeg)
    moment = TimelineMoment(start_seconds=0, end_seconds=2.1, transcript_text="")
    points = _select_event_frame_times(moment, boundaries)
    paths = extract_frames(video, points, tmp_path / "frames", ffmpeg)
    short_scene = [
        path for seconds, path in zip(points, paths, strict=True) if 1 < seconds < 1.1
    ]

    assert short_scene
    for path in short_scene:
        with Image.open(path) as frame:
            assert min(frame.convert("RGB").getpixel((32, 32))) > 240


@pytest.mark.parametrize(
    "start,end", [(-1, 2), (0, float("nan")), (0, float("inf")), (2, 1)]
)
def test_invalid_local_window_never_starts_decoder(tmp_path, monkeypatch, start, end):
    def unexpected_scan(*_args, **_kwargs):
        raise AssertionError("无效时间范围不应启动扫描")

    monkeypatch.setattr("openvideo.tools.scenes._scan_scene_scores", unexpected_scan)
    assert refine_scene_candidates(tmp_path / "video.mp4", start, end, 5, None) == []
