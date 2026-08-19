import pytest

from openvideo.tools.bilibili import InvalidBilibiliUrl, validate_bilibili_url


@pytest.mark.parametrize(
    ("source_url", "expected_url", "expected_id"),
    [
        (
            "https://www.bilibili.com/video/BV1xx411c7mD",
            "https://www.bilibili.com/video/BV1xx411c7mD",
            "BV1xx411c7mD",
        ),
        (
            "https://m.bilibili.com/video/BV1xx411c7mD?p=1",
            "https://www.bilibili.com/video/BV1xx411c7mD",
            "BV1xx411c7mD",
        ),
        ("https://b23.tv/AbC123", "https://b23.tv/AbC123", None),
    ],
)
def test_accepts_single_bilibili_video(source_url: str, expected_url: str, expected_id: str | None):
    source = validate_bilibili_url(source_url)
    assert source.normalized_url == expected_url
    assert source.source_video_id == expected_id


@pytest.mark.parametrize(
    "source_url",
    [
        "http://www.bilibili.com/video/BV1xx411c7mD",
        "https://bilibili.com.evil.example/video/BV1xx411c7mD",
        "https://user@www.bilibili.com/video/BV1xx411c7mD",
        "https://www.bilibili.com:444/video/BV1xx411c7mD",
        "https://www.bilibili.com/list/watchlater",
        "https://www.bilibili.com/video/BV1xx411c7mD?list=123",
        "https://b23.tv/a/b",
        "file:///etc/passwd",
    ],
)
def test_rejects_unsupported_or_deceptive_url(source_url: str):
    with pytest.raises(InvalidBilibiliUrl):
        validate_bilibili_url(source_url)
