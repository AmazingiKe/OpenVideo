import pytest

from openvideo.tools.downloader import parse_progress_percent


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
    assert parse_progress_percent(line) == expected


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
    assert parse_progress_percent(line) is None
