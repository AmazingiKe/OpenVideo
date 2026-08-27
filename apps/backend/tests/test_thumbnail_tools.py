from pathlib import Path
from types import SimpleNamespace

from openvideo.core.thumbnails import SCRUB_PROXY_FILE_NAME
from openvideo.tools import thumbnails as thumbnail_tools


def test_generates_short_gop_scrub_proxy(monkeypatch, tmp_path: Path):
    asset_directory = tmp_path / "media"
    video_path = tmp_path / "source.mp4"
    captured_command: list[str] = []

    monkeypatch.setattr(
        thumbnail_tools,
        "resolve_tool",
        lambda configured_path, tool_name, project_bin_dir: "ffmpeg",
    )

    def run_ffmpeg(command: list[str], **kwargs):
        captured_command.extend(command)
        Path(command[-1]).write_bytes(b"proxy")
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(thumbnail_tools.subprocess, "run", run_ffmpeg)

    proxy_file = thumbnail_tools.generate_scrub_proxy(
        video_path,
        asset_directory,
        configured_ffmpeg_path=None,
        project_bin_dir=None,
    )

    assert proxy_file == asset_directory / SCRUB_PROXY_FILE_NAME
    assert proxy_file.read_bytes() == b"proxy"
    assert captured_command[captured_command.index("-vf") + 1] == (
        "scale=-2:min(480\\,ih)"
    )
    assert captured_command[captured_command.index("-crf") + 1] == "36"
    assert captured_command[captured_command.index("-g") + 1] == "15"
    assert captured_command[captured_command.index("-keyint_min") + 1] == "15"
    assert "-an" in captured_command


def test_reuses_existing_scrub_proxy(monkeypatch, tmp_path: Path):
    asset_directory = tmp_path / "media"
    asset_directory.mkdir()
    proxy_file = asset_directory / SCRUB_PROXY_FILE_NAME
    proxy_file.write_bytes(b"existing")
    monkeypatch.setattr(
        thumbnail_tools.subprocess,
        "run",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("已有代理不应重复转码")
        ),
    )

    generated_file = thumbnail_tools.generate_scrub_proxy(
        tmp_path / "source.mp4",
        asset_directory,
        configured_ffmpeg_path="ffmpeg",
        project_bin_dir=None,
    )

    assert generated_file == proxy_file
