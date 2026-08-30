import pytest

from openvideo.tools.downloader import (
    DownloadProgress,
    download_progress_message,
    parse_download_progress,
)


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ("openvideo-progress:100.0%", 100.0),
        ("openvideo-progress:42.5%", 42.5),
        ("openvideo-progress:0.0%", 0.0),
        ("openvideo-progress:120.0%", 100.0),
        ("openvideo-progress:0%", 0.0),
    ],
)
def test_parses_progress_percent(line: str, expected: float):
    assert parse_download_progress(line) == DownloadProgress(expected, None, None)


@pytest.mark.parametrize(
    "line",
    [
        "",
        "openvideo-output:C:\\tmp\\video.mp4",
        "openvideo-progress:",
        "[download] Destination: video.mp4",
        "openvideo-progress:abc%",
    ],
)
def test_ignores_non_progress_lines(line: str):
    assert parse_download_progress(line) is None


def test_parses_speed_and_eta_for_user_visible_progress():
    progress = parse_download_progress("openvideo-progress:42.5%|12.3MiB/s|01:23")

    assert progress == DownloadProgress(42.5, "12.3MiB/s", "01:23")
    assert download_progress_message(progress) == (
        "正在下载视频 · 12.3MiB/s · 剩余 01:23"
    )


def test_ignores_unknown_speed_and_eta():
    progress = parse_download_progress("openvideo-progress:8.0%|Unknown B/s|NA")

    assert progress == DownloadProgress(8, None, None)
    assert download_progress_message(progress) == "正在下载视频"
