import subprocess
from pathlib import Path

from PIL import Image, ImageDraw
import pytest

from openvideo.tools.frame_quality import filter_candidate_frames
from openvideo.tools.scenes import refine_scene_candidates


def test_frame_quality_skips_black_blurry_and_duplicate_frames(tmp_path: Path):
    black = tmp_path / "black.jpg"
    blurry = tmp_path / "blurry.jpg"
    sharp = tmp_path / "sharp.jpg"
    duplicate = tmp_path / "duplicate.jpg"
    second = tmp_path / "second.jpg"
    Image.new("L", (192, 108), 0).save(black)
    Image.new("L", (192, 108), 128).save(blurry)
    _draw_interface_frame(sharp, offset=0)
    _draw_interface_frame(duplicate, offset=0)
    _draw_interface_frame(second, offset=17)

    qualified = filter_candidate_frames(
        [black, blurry, sharp, duplicate, second],
        [1, 2, 3, 4, 5],
    )

    assert [frame.seconds for frame in qualified] == [3, 5]
    assert all(frame.quality_score > 0 for frame in qualified)


def test_frame_quality_requires_stable_time_mapping(tmp_path: Path):
    with pytest.raises(ValueError, match="数量必须一致"):
        filter_candidate_frames([tmp_path / "frame.jpg"], [])


def test_scene_refinement_lowers_threshold_until_enough_boundaries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    media_path = tmp_path / "video.mp4"
    media_path.write_bytes(b"video")
    commands: list[list[str]] = []
    monkeypatch.setattr(
        "openvideo.tools.scenes.resolve_tool", lambda *_args, **_kwargs: "ffmpeg"
    )

    def run(command, **_kwargs):
        commands.append(command)
        filter_value = command[command.index("-vf") + 1]
        points = [2.0] if "0.42" in filter_value else [2.0, 6.0, 12.0, 17.0]
        stderr = "\n".join(f"showinfo pts_time:{point}" for point in points)
        return subprocess.CompletedProcess(command, 0, "", stderr)

    monkeypatch.setattr("openvideo.tools.scenes.subprocess.run", run)

    candidates = refine_scene_candidates(
        media_path,
        10,
        30,
        5,
        configured_ffmpeg_path=None,
    )

    assert len(candidates) == 5
    assert all(10 < seconds < 30 for seconds in candidates)
    assert len(commands) == 2
    assert all("0.16" not in command[command.index("-vf") + 1] for command in commands)


def _draw_interface_frame(path: Path, offset: int) -> None:
    image = Image.new("L", (192, 108), 42)
    draw = ImageDraw.Draw(image)
    draw.rectangle((8 + offset, 8, 183, 28), fill=220)
    draw.rectangle((8, 36, 70 + offset, 98), fill=95)
    draw.rectangle((78 + offset, 36, 183, 98), fill=170)
    for y in range(44, 94, 10):
        draw.line((86 + offset, y, 174, y), fill=20, width=2)
    image.save(path)
