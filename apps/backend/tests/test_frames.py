import subprocess
from pathlib import Path

import pytest

from openvideo.tools.frames import FrameExtractionError, extract_frames
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
