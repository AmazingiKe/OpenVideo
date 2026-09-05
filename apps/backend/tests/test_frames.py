import subprocess
import sys
from pathlib import Path
from threading import Event

import pytest
from PIL import Image, ImageChops

from openvideo.tools.frames import (
    FRAME_EXTRACTION_BATCH_SIZE,
    FrameExtractionError,
    _run_cancellable,
    extract_frames,
)
from openvideo.tools.media import resolve_tool


PROJECT_BIN_DIR = Path(__file__).resolve().parents[3] / "tools" / "ffmpeg" / "bin"


def test_extract_frames_requires_media(tmp_path: Path):
    with pytest.raises(FrameExtractionError, match="视频文件不存在"):
        extract_frames(
            tmp_path / "missing.mp4",
            [1.0],
            tmp_path / "frames",
            configured_ffmpeg_path=None,
        )


@pytest.mark.parametrize("seconds", [-0.1, float("nan"), float("inf")])
def test_extract_frames_rejects_invalid_times_before_starting_ffmpeg(
    tmp_path: Path, seconds: float
):
    with pytest.raises(FrameExtractionError, match="非负有限"):
        extract_frames(tmp_path / "video.mp4", [seconds], tmp_path / "frames", None)


def test_empty_frame_request_does_not_require_media_or_ffmpeg(tmp_path: Path):
    assert extract_frames(tmp_path / "missing.mp4", [], tmp_path / "frames", None) == []


def test_batch_extraction_preserves_requested_order_and_limits_decoder_count(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    media = tmp_path / "video.mp4"
    media.write_bytes(b"video")
    commands = []

    def run(command, **_kwargs):
        commands.append(command)
        for value in command:
            if value.endswith(".jpg"):
                Path(value).write_bytes(b"frame")
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr("openvideo.tools.frames.resolve_tool", lambda *_: "ffmpeg")
    monkeypatch.setattr("openvideo.tools.frames.subprocess.run", run)
    seconds = [9.125, 2.375, 9.125, 6.5, 3.25]
    paths = extract_frames(media, seconds, tmp_path / "frames", None)

    assert len(commands) == 2
    assert all(
        command.count("-i") <= FRAME_EXTRACTION_BATCH_SIZE for command in commands
    )
    assert [path.name for path in paths] == [
        f"frame_{index:03d}_{point:.3f}s.jpg" for index, point in enumerate(seconds)
    ]
    assert [
        float(command[index + 1])
        for command in commands
        for index, value in enumerate(command)
        if value == "-ss"
    ] == seconds


def test_cancellable_process_drains_large_error_output():
    result = _run_cancellable(
        [sys.executable, "-c", "import sys; sys.stderr.write('x' * 1_000_000)"],
        Event(),
    )

    assert result.returncode == 0
    assert len(result.stderr) == 1_000_000


def test_extracts_frames_from_video(tmp_path: Path):
    ffmpeg_path = resolve_tool(None, "ffmpeg", PROJECT_BIN_DIR)
    if not ffmpeg_path:
        pytest.skip("未找到 ffmpeg")
    video = tmp_path / "sample.mp4"
    subprocess.run(
        [
            ffmpeg_path,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=320x240:d=1",
            "-pix_fmt",
            "yuv420p",
            str(video),
        ],
        capture_output=True,
        check=True,
    )

    frames = extract_frames(
        video,
        [0.5, 0.8],
        tmp_path / "frames",
        configured_ffmpeg_path=None,
        project_bin_dir=PROJECT_BIN_DIR,
    )

    assert len(frames) == 2
    assert all(frame.is_file() for frame in frames)


@pytest.mark.parametrize("cancellable", [False, True])
def test_batch_extraction_matches_independent_seeks_on_moving_video(
    tmp_path: Path, cancellable: bool
):
    ffmpeg_path = resolve_tool(None, "ffmpeg", PROJECT_BIN_DIR)
    if not ffmpeg_path:
        pytest.skip("未找到 ffmpeg")
    video = tmp_path / "moving.mp4"
    subprocess.run(
        [
            ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x120:rate=30:duration=3",
            "-c:v",
            "mpeg4",
            "-g",
            "30",
            str(video),
        ],
        capture_output=True,
        check=True,
        timeout=30,
    )
    time_points = [2.375, 0.05, 1.125, 2.375, 0.975]
    batched = extract_frames(
        video,
        time_points,
        tmp_path / "batched",
        ffmpeg_path,
        cancel_event=Event() if cancellable else None,
    )
    for index, (seconds, frame_path) in enumerate(
        zip(time_points, batched, strict=True)
    ):
        reference = tmp_path / f"reference-{index}.jpg"
        subprocess.run(
            [
                ffmpeg_path,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                str(seconds),
                "-i",
                str(video),
                "-frames:v",
                "1",
                "-q:v",
                "2",
                str(reference),
            ],
            capture_output=True,
            check=True,
            timeout=30,
        )
        with Image.open(reference) as expected, Image.open(frame_path) as actual:
            difference = ImageChops.difference(
                expected.convert("RGB"), actual.convert("RGB")
            )
            assert difference.getbbox() is None
    assert batched[0].read_bytes() == batched[3].read_bytes()
    assert batched[0].read_bytes() != batched[1].read_bytes()


def test_extract_frames_terminates_ffmpeg_when_cancelled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    media_path = tmp_path / "video.mp4"
    media_path.write_bytes(b"video")
    process = CancellableProcess()
    monkeypatch.setattr(
        "openvideo.tools.frames.resolve_tool",
        lambda *_args, **_kwargs: "ffmpeg",
    )
    monkeypatch.setattr(
        "openvideo.tools.frames.subprocess.Popen", lambda *_args, **_kwargs: process
    )

    with pytest.raises(FrameExtractionError, match="已取消"):
        extract_frames(
            media_path,
            [1.0],
            tmp_path / "frames",
            configured_ffmpeg_path=None,
            cancel_event=CancelOnWait(),
        )

    assert process.terminated is True
    assert process.killed is False


class CancelOnWait:
    def is_set(self) -> bool:
        return False

    def wait(self, _timeout: float) -> bool:
        return True


class CancellableProcess:
    returncode = None

    def __init__(self):
        self.terminated = False
        self.killed = False

    def poll(self):
        return 0 if self.terminated or self.killed else None

    def terminate(self):
        self.terminated = True
        self.returncode = -1

    def kill(self):
        self.killed = True
        self.returncode = -1

    def wait(self, timeout: int):
        return self.returncode
