from pathlib import Path

import pytest

from openvideo.core.download_models import DownloadQuality
from openvideo.core.media_models import SourcePlatform
from openvideo.tools import downloader
from openvideo.tools.downloader import (
    DownloadFailure,
    DownloadMetadata,
    _network_arguments,
    _transfer_directory,
    download_video,
    platform_download_proxy,
)


SOURCE_URL = "https://www.youtube.com/watch?v=BaW_jenozKc"


def test_transfer_directory_reuses_matching_partial_files(tmp_path: Path):
    staging_root = tmp_path / "staging"
    first_directory = _transfer_directory(
        staging_root,
        SOURCE_URL,
        SourcePlatform.YOUTUBE,
        DownloadQuality.FULL_HD_1080,
    )
    partial_file = first_directory / "download.f137.mp4.part"
    partial_file.write_bytes(b"partial")

    retry_directory = _transfer_directory(
        staging_root,
        SOURCE_URL,
        SourcePlatform.YOUTUBE,
        DownloadQuality.FULL_HD_1080,
    )
    different_quality_directory = _transfer_directory(
        staging_root,
        SOURCE_URL,
        SourcePlatform.YOUTUBE,
        DownloadQuality.HD_720,
    )

    assert retry_directory == first_directory
    assert partial_file.read_bytes() == b"partial"
    assert different_quality_directory != first_directory


def test_network_arguments_include_retries_and_optional_proxy():
    arguments = _network_arguments("http://127.0.0.1:7890")

    assert arguments[arguments.index("--socket-timeout") + 1] == "30"
    assert arguments[arguments.index("--fragment-retries") + 1] == "20"
    assert arguments.count("--retry-sleep") == 2
    assert arguments[-2:] == ["--proxy", "http://127.0.0.1:7890"]


def test_proxy_is_only_used_for_overseas_platforms():
    configured_proxy = "http://127.0.0.1:7890"

    assert (
        platform_download_proxy(SourcePlatform.YOUTUBE, configured_proxy)
        == configured_proxy
    )
    assert platform_download_proxy(SourcePlatform.BILIBILI, configured_proxy) == ""
    assert platform_download_proxy(SourcePlatform.DOUYIN, configured_proxy) == ""
    assert _network_arguments("")[-2:] == ["--proxy", ""]


def test_failed_download_keeps_partial_and_retry_resumes_it(
    monkeypatch, tmp_path: Path
):
    asset_directory = tmp_path / "asset" / "media"
    asset_directory.mkdir(parents=True)
    staging_root = tmp_path / "temp" / "download-asset"
    commands: list[list[str]] = []
    attempts = 0

    monkeypatch.setattr(downloader, "yt_dlp_available", lambda: True)
    monkeypatch.setattr(downloader, "resolve_tool", lambda *_: "ffmpeg")
    monkeypatch.setattr(
        downloader,
        "read_download_metadata",
        lambda *_: DownloadMetadata(
            source_video_id="BaW_jenozKc",
            title="续传测试",
            author_name=None,
            description=None,
            duration_seconds=30,
            width=1280,
            height=720,
            thumbnail_url=None,
        ),
    )

    def run_download(command, transfer_directory, _on_progress):
        nonlocal attempts
        attempts += 1
        commands.append(command)
        partial_file = transfer_directory / "download.f137.mp4.part"
        if attempts == 1:
            partial_file.write_bytes(b"partial")
            raise DownloadFailure("网络连接中断")
        assert partial_file.read_bytes() == b"partial"
        output_file = transfer_directory / "download.mp4"
        output_file.write_bytes(b"complete")
        return output_file

    monkeypatch.setattr(downloader, "_run_download", run_download)
    callbacks = (lambda *_: None, lambda *_: None, lambda *_: None)

    with pytest.raises(DownloadFailure, match="网络连接中断"):
        download_video(
            SOURCE_URL,
            SourcePlatform.YOUTUBE,
            asset_directory,
            None,
            None,
            *callbacks,
            video_quality=DownloadQuality.HD_720,
            staging_directory=staging_root,
            download_proxy="http://127.0.0.1:7890",
        )

    downloaded = download_video(
        SOURCE_URL,
        SourcePlatform.YOUTUBE,
        asset_directory,
        None,
        None,
        *callbacks,
        video_quality=DownloadQuality.HD_720,
        staging_directory=staging_root,
        download_proxy="http://127.0.0.1:7890",
    )

    assert downloaded.playback_file.read_bytes() == b"complete"
    assert "--continue" in commands[1]
    assert "--part" in commands[1]
    assert commands[1][commands[1].index("--concurrent-fragments") + 1] == "4"
    assert commands[1][commands[1].index("--proxy") + 1] == ("http://127.0.0.1:7890")
    assert not staging_root.exists()
