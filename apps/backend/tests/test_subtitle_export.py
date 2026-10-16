import shutil
import subprocess
from pathlib import Path
from subprocess import CompletedProcess

import pytest

from openvideo.core.media_models import SubtitleDisplaySettings, SubtitleFileFormat
from openvideo.core.transcription_models import TranscriptSegment
from openvideo.tools import subtitle_export


FFMPEG_PATH = shutil.which("ffmpeg")


@pytest.mark.parametrize(
    ("file_format", "expected"),
    [
        (
            SubtitleFileFormat.SRT,
            "1\n00:00:59,999 --> 00:01:00,000\n中文 &lt;b&gt;原文&lt;/b&gt; &amp; 字幕\n第二行\n",
        ),
        (
            SubtitleFileFormat.VTT,
            "WEBVTT\n\n00:00:59.999 --> 00:01:00.000\n中文 &lt;b&gt;原文&lt;/b&gt; &amp; 字幕\n第二行\n",
        ),
        (
            SubtitleFileFormat.TXT,
            "中文 <b>原文</b> & 字幕\n第二行\n",
        ),
    ],
)
def test_renders_utf8_subtitle_files_and_carries_rounded_milliseconds(
    file_format: SubtitleFileFormat, expected: str
):
    document = subtitle_export.render_subtitle_file(
        [
            TranscriptSegment(
                start_seconds=59.9994,
                end_seconds=59.9996,
                text="中文 <b>原文</b> & 字幕\r\n第二行",
            )
        ],
        file_format,
    )

    assert document == expected


def test_orders_cues_and_applies_display_offset_and_video_bounds_without_mutation():
    segments = [
        TranscriptSegment(start_seconds=3, end_seconds=7, text="末尾"),
        TranscriptSegment(start_seconds=0.2, end_seconds=2, text="开头"),
        TranscriptSegment(start_seconds=0, end_seconds=0.2, text="提前后不可见"),
        TranscriptSegment(start_seconds=1, end_seconds=2, text=" \t\n"),
        TranscriptSegment(start_seconds=8, end_seconds=9, text="片外"),
        TranscriptSegment(start_seconds=2, end_seconds=2, text="零时长"),
    ]
    original_segments = [segment.model_dump() for segment in segments]

    document = subtitle_export.render_subtitle_file(
        segments,
        SubtitleFileFormat.SRT,
        offset_milliseconds=500,
        duration_seconds=5,
    )

    assert document == (
        "1\n00:00:00,000 --> 00:00:01,500\n开头\n\n"
        "2\n00:00:02,500 --> 00:00:05,000\n末尾\n"
    )
    assert [segment.model_dump() for segment in segments] == original_segments


def test_negative_display_offset_delays_subtitle_files():
    document = subtitle_export.render_subtitle_file(
        [TranscriptSegment(start_seconds=0, end_seconds=1, text="延后")],
        SubtitleFileFormat.VTT,
        offset_milliseconds=-500,
    )

    assert "00:00:00.500 --> 00:00:01.500" in document


def test_subtitle_text_cannot_inject_cue_boundaries_or_markup():
    document = subtitle_export.render_subtitle_file(
        [
            TranscriptSegment(
                start_seconds=0,
                end_seconds=1,
                text="首行\n \t\n00:00:10.000 --> 00:00:11.000\n<script>文本</script>\x00",
            )
        ],
        SubtitleFileFormat.VTT,
    )

    assert document.count("\n\n") == 1
    assert document.count(" --> ") == 1
    assert "00:00:10.000 --&gt; 00:00:11.000" in document
    assert "&lt;script&gt;文本&lt;/script&gt;" in document
    assert "\x00" not in document


@pytest.mark.parametrize(
    ("start", "end"),
    [
        (float("inf"), float("inf")),
        (0, float("nan")),
        (1e308, 1.1e308),
        (2, 1),
        (1.0001, 1.0002),
    ],
)
def test_rejects_non_finite_invalid_and_submillisecond_ranges(start: float, end: float):
    segment = TranscriptSegment.model_construct(
        start_seconds=start, end_seconds=end, text="不可用"
    )
    with pytest.raises(subtitle_export.SubtitleExportError, match="没有可导出的字幕"):
        subtitle_export.render_subtitle_file([segment], SubtitleFileFormat.SRT)


def test_rounds_hour_boundary_and_supports_long_videos():
    document = subtitle_export.render_subtitle_file(
        [TranscriptSegment(start_seconds=3599.9996, end_seconds=360001, text="长视频")],
        SubtitleFileFormat.SRT,
    )

    assert "01:00:00,000 --> 100:00:01,000" in document


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
