import httpx

from openvideo.core.media_models import SourcePlatform
from openvideo.tools import downloader
from openvideo.tools.downloader import _friendly_failure, parse_playlist_payload, probe_source


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


def test_reports_fresh_cookie_requirement_as_an_expired_login():
    message = _friendly_failure("ERROR: [Douyin] video: Fresh cookies are needed")
    assert message == "保存的登录状态已失效，请重新登录"


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
            request=httpx.Request("GET", "https://api.bilibili.com/x/web-interface/view"),
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
