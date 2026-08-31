import shutil
import subprocess
from pathlib import Path
from subprocess import CompletedProcess

import pytest

from openvideo.core.media_models import SubtitleDisplaySettings
from openvideo.core.transcription_models import TranscriptSegment
from openvideo.tools import subtitle_export


FFMPEG_PATH = shutil.which("ffmpeg")


def test_builds_ass_document_from_display_settings():
    document = subtitle_export.build_ass_document(
        [
            TranscriptSegment(
                start_seconds=1.25,
                end_seconds=3.5,
                text="第一行\n第二行 {安全}",
            )
        ],
        SubtitleDisplaySettings(
            font_size="large",
            position="center",
            background="solid",
        ),
    )

    assert "Microsoft YaHei,64" in document
    assert ",3,0,0,5,64,64,0,1" in document
    assert "Dialogue: 0,0:00:01.25,0:00:03.50" in document
    assert r"第一行\N第二行 ｛安全｝" in document


def test_exports_video_atomically_and_removes_temporary_files(
    monkeypatch, tmp_path: Path
):
    media_path = tmp_path / "source.mp4"
    output_path = tmp_path / "exports" / "subtitled.mp4"
    media_path.write_bytes(b"video")
    captured_command: list[str] = []

    monkeypatch.setattr(
        subtitle_export,
        "resolve_tool",
        lambda *_args: "ffmpeg",
    )

    def run(command: list[str], **_kwargs) -> CompletedProcess[str]:
        captured_command.extend(command)
        Path(command[-1]).write_bytes(b"exported-video")
        return CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(subtitle_export.subprocess, "run", run)

    subtitle_export.export_subtitled_video(
        media_path,
        [TranscriptSegment(start_seconds=0, end_seconds=1, text="字幕")],
        SubtitleDisplaySettings(),
        output_path,
        None,
    )

    assert output_path.read_bytes() == b"exported-video"
    assert captured_command[captured_command.index("-vf") + 1].startswith(
        "ass=filename='"
    )
    assert list(output_path.parent.glob("*.ass")) == []
    assert list(output_path.parent.glob("*.pending.mp4")) == []


@pytest.mark.skipif(FFMPEG_PATH is None, reason="本机未安装 ffmpeg")
def test_ffmpeg_burns_subtitles_into_a_standalone_video(tmp_path: Path):
    source_path = tmp_path / "source.mp4"
    output_path = tmp_path / "exports" / "subtitled.mp4"
    subprocess.run(
        [
            FFMPEG_PATH,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=320x180:d=1",
            "-pix_fmt",
            "yuv420p",
            str(source_path),
        ],
        check=True,
        capture_output=True,
    )

    subtitle_export.export_subtitled_video(
        source_path,
        [TranscriptSegment(start_seconds=0, end_seconds=1, text="真实导出字幕")],
        SubtitleDisplaySettings(
            font_size="large",
            position="raised",
            background="solid",
        ),
        output_path,
        FFMPEG_PATH,
    )

    assert output_path.is_file()
    assert output_path.stat().st_size > source_path.stat().st_size
