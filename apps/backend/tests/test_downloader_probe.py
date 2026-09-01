import httpx
import pytest

from openvideo.core.download_models import DownloadQuality
from openvideo.core.media_models import SourcePlatform
from openvideo.tools import downloader
from openvideo.tools.downloader import (
    _friendly_failure,
    download_format,
    parse_playlist_payload,
    probe_source,
)


def test_download_format_applies_selected_maximum_height():
    selected_format = download_format(
        SourcePlatform.YOUTUBE,
        DownloadQuality.FULL_HD_1080,
    )

    assert "bestvideo[vcodec^=avc1][height<=1080]" in selected_format
    assert "bestvideo[vcodec^=avc1][width<=1080]" in selected_format
    assert selected_format.endswith("best[width<=1080]")


def test_download_format_supports_portrait_short_edge_quality():
    selected_format = download_format(
        SourcePlatform.BILIBILI,
        DownloadQuality.SD_480,
    )

    assert "bestvideo[vcodec^=avc1][height<=480]" in selected_format
    assert "bestvideo[vcodec^=avc1][width<=480]" in selected_format


def test_best_download_format_has_no_height_limit():
    selected_format = download_format(
        SourcePlatform.DOUYIN,
        DownloadQuality.BEST,
    )

    assert selected_format == "best[ext=mp4]/best"


def test_single_video_payload_is_not_playlist():
    payload = {
        "id": "vtR7cgYATdk",
        "title": "示例视频",
        "duration": 212.0,
        "uploader": "示例作者",
    }
    probe = parse_playlist_payload(payload)
    assert probe.is_playlist is False
    assert probe.total_count == 1
    assert probe.truncated is False
    assert len(probe.entries) == 1
    entry = probe.entries[0]
    assert entry.source_video_id == "vtR7cgYATdk"
    assert entry.title == "示例视频"
    assert entry.duration_seconds == 212.0


def test_playlist_payload_collects_entries():
    payload = {
        "title": "合集标题",
        "playlist_count": 3,
        "entries": [
            {"id": "aaaaaaaaaaa", "title": "第一集", "duration": 60, "url": "https://youtu.be/aaaaaaaaaaa"},
            {"id": "bbbbbbbbbbb", "title": "第二集", "duration": 90},
            {"id": "ccccccccccc", "title": "第三集"},
        ],
    }
    probe = parse_playlist_payload(payload)
    assert probe.is_playlist is True
    assert probe.title == "合集标题"
    assert probe.total_count == 3
    assert probe.truncated is False
    assert [entry.source_video_id for entry in probe.entries] == [
        "aaaaaaaaaaa",
        "bbbbbbbbbbb",
        "ccccccccccc",
    ]


def test_playlist_payload_marks_truncated_when_count_exceeds_entries():
    payload = {
        "title": "长列表",
        "playlist_count": 250,
        "entries": [{"id": "aaaaaaaaaaa", "title": "第一集"}],
    }
    probe = parse_playlist_payload(payload)
    assert probe.is_playlist is True
    assert probe.total_count == 250
    assert probe.truncated is True


def test_playlist_payload_skips_entries_without_id():
    payload = {
        "entries": [
            {"title": "缺少 ID 的条目"},
            {"id": "aaaaaaaaaaa", "title": "有效条目"},
        ],
    }
    probe = parse_playlist_payload(payload)
    assert [entry.source_video_id for entry in probe.entries] == ["aaaaaaaaaaa"]


def test_playlist_payload_recovers_bilibili_part_ids_from_flat_urls():
    payload = {
        "title": "分P视频",
        "playlist_count": 2,
        "entries": [
            {
                "_type": "url",
                "url": "https://www.bilibili.com/video/BV1X7411F744?p=1",
            },
            {
                "_type": "url",
                "url": "https://www.bilibili.com/video/BV1X7411F744?p=2",
            },
        ],
    }

    probe = parse_playlist_payload(payload)

    assert [entry.source_video_id for entry in probe.entries] == [
        "BV1X7411F744_p1",
        "BV1X7411F744_p2",
    ]
    assert probe.truncated is False


def test_reports_fresh_cookie_requirement_as_an_expired_login():
    message = _friendly_failure("ERROR: [Douyin] video: Fresh cookies are needed")
    assert message == "保存的登录状态已失效，请重新登录"


@pytest.mark.parametrize(
    ("diagnostic", "message"),
    [
        (
            "OSError: [Errno 28] No space left on device",
            "磁盘空间不足，已保留下载进度；释放空间后可继续下载",
        ),
        (
            "HTTP Error 429: Too Many Requests",
            "平台请求过于频繁，已保留下载进度；稍后可继续下载",
        ),
        (
            "Connection reset by peer",
            "网络连接中断，已保留下载进度；网络恢复后可继续下载",
        ),
        (
            "This video is not available in your country",
            "视频受地区限制，请配置可访问该平台的下载代理",
        ),
        (
            "Postprocessing: ffmpeg exited with code 1",
            "视频音频合并失败，请检查 FFmpeg 是否可用",
        ),
    ],
)
def test_reports_actionable_download_failures(diagnostic: str, message: str):
    assert _friendly_failure(diagnostic) == message


def test_bilibili_ugc_season_probe_returns_all_episodes(monkeypatch):
    payload = {
        "code": 0,
        "data": {
            "ugc_season": {
                "title": "示例合集",
                "sections": [{
                    "episodes": [
                        {
                            "bvid": "BV1xx411c7mD",
                            "title": "第一集",
                            "arc": {
                                "duration": 60,
                                "author": {"name": "示例作者"},
                            },
                        },
                        {
                            "bvid": "BV1xx411c7mE",
                            "title": "第二集",
                            "arc": {"duration": 90},
                        },
                    ],
                }],
            },
        },
    }
    request_arguments = {}

    def get_bilibili_view(*args, **kwargs):
        request_arguments.update(kwargs)
        return httpx.Response(
            200,
            json=payload,
            request=httpx.Request(
                "GET",
                "https://api.bilibili.com/x/web-interface/view",
            ),
        )

    monkeypatch.setattr(
        downloader.httpx,
        "get",
        get_bilibili_view,
    )

    probe = probe_source(
        "https://www.bilibili.com/video/BV1xx411c7mD",
        SourcePlatform.BILIBILI,
        "BV1xx411c7mD",
    )

    assert probe.is_playlist is True
    assert probe.title == "示例合集"
    assert probe.total_count == 2
    assert [entry.source_video_id for entry in probe.entries] == ["BV1xx411c7mD", "BV1xx411c7mE"]
    assert probe.entries[0].uploader == "示例作者"
    assert request_arguments["headers"]["Referer"] == "https://www.bilibili.com/"


def test_bilibili_multipart_probe_returns_downloadable_parts(monkeypatch):
    payload = {
        "code": 0,
        "data": {
            "title": "GAMES101-现代计算机图形学入门-闫令琪",
            "owner": {"name": "GAMES-Webinar"},
            "pages": [
                {"page": 1, "part": "Lecture 01 Overview", "duration": 3589},
                {"page": 2, "part": "Lecture 02 Linear Algebra", "duration": 3588},
            ],
        },
    }
    request_arguments = {}

    def get_bilibili_view(*args, **kwargs):
        request_arguments.update(kwargs)
        return httpx.Response(
            200,
            json=payload,
            request=httpx.Request("GET", "https://api.bilibili.com/x/web-interface/view"),
        )

    monkeypatch.setattr(downloader.httpx, "get", get_bilibili_view)

    probe = probe_source(
        "https://www.bilibili.com/video/BV1X7411F744?p=2",
        SourcePlatform.BILIBILI,
        "BV1X7411F744_p2",
    )

    assert probe.is_playlist is True
    assert probe.title == "GAMES101-现代计算机图形学入门-闫令琪"
    assert [entry.source_video_id for entry in probe.entries] == [
        "BV1X7411F744_p1",
        "BV1X7411F744_p2",
    ]
    assert [entry.url for entry in probe.entries] == [
        "https://www.bilibili.com/video/BV1X7411F744?p=1",
        "https://www.bilibili.com/video/BV1X7411F744?p=2",
    ]
    assert probe.entries[1].title == "Lecture 02 Linear Algebra"
    assert probe.entries[1].duration_seconds == 3588
    assert probe.entries[1].uploader == "GAMES-Webinar"
    assert request_arguments["params"] == {"bvid": "BV1X7411F744"}


def test_bilibili_single_video_probe_uses_view_api_without_yt_dlp(monkeypatch):
    payload = {
        "code": 0,
        "data": {
            "bvid": "BV1L54y147zi",
            "title": "【算法】二叉树的动画介绍（AVL树）",
            "duration": 260,
            "owner": {"name": "从0开始数"},
            "pages": [
                {
                    "page": 1,
                    "part": "【算法】二叉树的动画介绍（AVL树）",
                    "duration": 260,
                }
            ],
        },
    }

    def get_bilibili_view(*args, **kwargs):
        return httpx.Response(
            200,
            json=payload,
            request=httpx.Request("GET", "https://api.bilibili.com/x/web-interface/view"),
        )

    def reject_yt_dlp_fallback(*args, **kwargs):
        raise AssertionError("单个 Bilibili 视频不应再次调用 yt-dlp 探测")

    monkeypatch.setattr(downloader.httpx, "get", get_bilibili_view)
    monkeypatch.setattr(downloader, "probe_playlist", reject_yt_dlp_fallback)

    probe = probe_source(
        "https://www.bilibili.com/video/BV1L54y147zi",
        SourcePlatform.BILIBILI,
        "BV1L54y147zi",
    )

    assert probe.is_playlist is False
    assert probe.total_count == 1
    assert probe.entries == [
        downloader.PlaylistEntry(
            source_video_id="BV1L54y147zi",
            url="https://www.bilibili.com/video/BV1L54y147zi",
            title="【算法】二叉树的动画介绍（AVL树）",
            duration_seconds=260,
            uploader="从0开始数",
        )
    ]
