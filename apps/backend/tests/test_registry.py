import pytest

from openvideo.core.models import SourcePlatform
from openvideo.tools.sources import UnsupportedSourceError, resolve_source


@pytest.mark.parametrize(
    ("source_url", "expected_platform", "expected_url", "expected_id", "expected_playlist"),
    [
        (
            "https://www.bilibili.com/video/BV1xx411c7mD",
            SourcePlatform.BILIBILI,
            "https://www.bilibili.com/video/BV1xx411c7mD",
            "BV1xx411c7mD",
            False,
        ),
        (
            "https://m.bilibili.com/video/BV1xx411c7mD?p=1",
            SourcePlatform.BILIBILI,
            "https://www.bilibili.com/video/BV1xx411c7mD",
            "BV1xx411c7mD",
            False,
        ),
        ("https://b23.tv/AbC123", SourcePlatform.BILIBILI, "https://b23.tv/AbC123", None, False),
        (
            "https://www.bilibili.com/video/BV1xx411c7mD?list=123",
            SourcePlatform.BILIBILI,
            "https://www.bilibili.com/video/BV1xx411c7mD",
            "BV1xx411c7mD",
            True,
        ),
        (
            "https://www.bilibili.com/list/ml123",
            SourcePlatform.BILIBILI,
            "https://www.bilibili.com/list/ml123",
            None,
            True,
        ),
        (
            "https://m.douyin.com/video/6961737553342991651?previous_page=app_code_link",
            SourcePlatform.DOUYIN,
            "https://www.douyin.com/video/6961737553342991651",
            "6961737553342991651",
            False,
        ),
        (
            "https://v.douyin.com/i2fr44YG/",
            SourcePlatform.DOUYIN,
            "https://v.douyin.com/i2fr44YG",
            None,
            False,
        ),
        (
            "https://www.douyin.com/search/dy?modal_id=7676366977263042789",
            SourcePlatform.DOUYIN,
            "https://www.douyin.com/video/7676366977263042789",
            "7676366977263042789",
            False,
        ),
        (
            "https://www.youtube.com/watch?v=vtR7cgYATdk",
            SourcePlatform.YOUTUBE,
            "https://www.youtube.com/watch?v=vtR7cgYATdk",
            "vtR7cgYATdk",
            False,
        ),
        (
            "https://youtu.be/vtR7cgYATdk",
            SourcePlatform.YOUTUBE,
            "https://www.youtube.com/watch?v=vtR7cgYATdk",
            "vtR7cgYATdk",
            False,
        ),
        (
            "https://www.youtube.com/playlist?list=PL1234567890",
            SourcePlatform.YOUTUBE,
            "https://www.youtube.com/playlist?list=PL1234567890",
            None,
            True,
        ),
        (
            "https://www.youtube.com/watch?v=vtR7cgYATdk&list=PL1234567890",
            SourcePlatform.YOUTUBE,
            "https://www.youtube.com/watch?v=vtR7cgYATdk",
            "vtR7cgYATdk",
            True,
        ),
    ],
)
def test_resolves_supported_urls(
    source_url: str,
    expected_platform: SourcePlatform,
    expected_url: str,
    expected_id: str | None,
    expected_playlist: bool,
):
    match = resolve_source(source_url)
    assert match.platform == expected_platform
    assert match.normalized_url == expected_url
    assert match.source_video_id == expected_id
    assert match.is_playlist == expected_playlist


@pytest.mark.parametrize(
    "source_url",
    [
        "http://www.bilibili.com/video/BV1xx411c7mD",
        "http://www.youtube.com/watch?v=vtR7cgYATdk",
        "https://bilibili.com.evil.example/video/BV1xx411c7mD",
        "https://youtube.com.evil.example/watch?v=vtR7cgYATdk",
        "https://user@www.bilibili.com/video/BV1xx411c7mD",
        "https://www.bilibili.com:444/video/BV1xx411c7mD",
        "https://www.bilibili.com/video/notabv",
        "https://www.youtube.com/watch?v=tooshort",
        "https://www.youtube.com/watch?v=vtR7cgYATdkZZZ",
        "https://www.douyin.com/video/not-a-video-id",
        "https://www.douyin.com/user/123",
        "https://www.douyin.com/search/dy",
        "https://www.douyin.com/search/dy?modal_id=not-a-video-id",
        "https://v.douyin.com/a/b",
        "https://b23.tv/a/b",
        "file:///etc/passwd",
        "https://example.com/video/BV1xx411c7mD",
        "https://www.bilibili.com/",
    ],
)
def test_rejects_unsupported_or_deceptive_url(source_url: str):
    with pytest.raises(UnsupportedSourceError):
        resolve_source(source_url)
