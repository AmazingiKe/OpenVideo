from fastapi.testclient import TestClient
import pytest
import time
from threading import Event
from uuid import UUID

from openvideo.core.media_models import SourcePlatform
from openvideo.download_accounts import (
    DownloadAccountLoginCancelled,
    DownloadAccountStore,
    DownloadCookieBrowser,
)
from openvideo.settings import Settings
from openvideo.tools.downloader import (
    DownloadFailure,
    DownloadMetadata,
    PlaylistEntry,
    PlaylistProbe,
)
from openvideo.ui import api


class MemoryDownloadAccountSecretStore:
    def __init__(self) -> None:
        self.secrets: dict[str, str] = {}

    def load(self, account_id: str) -> str | None:
        return self.secrets.get(account_id)

    def save(self, account_id: str, cookie_secret: str) -> None:
        self.secrets[account_id] = cookie_secret

    def delete(self, account_id: str) -> None:
        self.secrets.pop(account_id, None)


def test_probe_returns_a_normalized_douyin_download_url(monkeypatch, tmp_path):
    probe_targets: list[str] = []

    def probe_douyin(source_url: str, *_: object) -> PlaylistProbe:
        probe_targets.append(source_url)
        return PlaylistProbe(
            is_playlist=False,
            title=None,
            entries=[
                PlaylistEntry(
                    source_video_id="6961737553342991651",
                    url="",
                    title="示例抖音视频",
                    duration_seconds=19,
                    uploader="示例作者",
                )
            ],
            truncated=False,
            total_count=1,
        )

    monkeypatch.setattr(api, "probe_source", probe_douyin)
    app = api.create_app(Settings(library_path=tmp_path))
    with TestClient(app) as client:
        response = client.post(
            "/api/downloads/probe",
            json={
                "source_url": (
                    "https://www.douyin.com/search/dy?modal_id=6961737553342991651"
                )
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["platform"] == "douyin"
    assert (
        payload["entries"][0]["url"]
        == "https://www.douyin.com/video/6961737553342991651"
    )
    assert probe_targets == ["https://www.douyin.com/video/6961737553342991651"]


def test_probe_preserves_bilibili_part_download_urls(monkeypatch, tmp_path):
    def probe_bilibili(*_: object) -> PlaylistProbe:
        return PlaylistProbe(
            is_playlist=True,
            title="分P视频",
            entries=[
                PlaylistEntry(
                    source_video_id="BV1X7411F744_p2",
                    url="https://www.bilibili.com/video/BV1X7411F744?p=2",
                    title="第二P",
                    duration_seconds=60,
                    uploader="示例作者",
                )
            ],
            truncated=False,
            total_count=1,
        )

    monkeypatch.setattr(api, "probe_source", probe_bilibili)
    app = api.create_app(Settings(library_path=tmp_path))

    with TestClient(app) as client:
        response = client.post(
            "/api/downloads/probe",
            json={
                "source_url": (
                    "https://www.bilibili.com/video/BV1X7411F744/"
                    "?p=2&spm_id_from=333.337.search-card.all.click"
                )
            },
        )

    assert response.status_code == 200
    assert response.json()["entries"][0]["url"] == (
        "https://www.bilibili.com/video/BV1X7411F744?p=2"
    )


def test_platform_account_can_be_saved_tested_listed_and_removed(
    monkeypatch,
    tmp_path,
):
    tested_cookie_files: list[str] = []

    def read_metadata(source_url, platform, cookie_source):
        tested_cookie_files.append(cookie_source.read_text(encoding="utf-8"))
        return DownloadMetadata(
            source_video_id="6961737553342991651",
            title="示例抖音视频",
            author_name="示例作者",
            description=None,
            duration_seconds=19,
            width=1080,
            height=1920,
            thumbnail_url=None,
        )

    monkeypatch.setattr(api, "read_download_metadata", read_metadata)
    account_store = DownloadAccountStore(
        tmp_path / "config",
        MemoryDownloadAccountSecretStore(),
    )
    app = api.create_app(
        Settings(library_path=tmp_path / "library"),
        download_account_store=account_store,
    )
    with TestClient(app) as client:
        saved_response = client.put(
            "/api/download-accounts/douyin",
            json={"cookie": "ttwid=device-token; sessionid=login-token"},
        )
        listed_response = client.get("/api/download-accounts")
        tested_response = client.post(
            "/api/download-accounts/douyin/test",
            json={"source_url": "https://www.douyin.com/video/6961737553342991651"},
        )
        deleted_response = client.delete("/api/download-accounts/douyin")
        missing_response = client.get("/api/download-accounts/douyin")

    assert saved_response.status_code == 200
    assert saved_response.json()["status"] == "untested"
    assert "cookie" not in saved_response.json()
    assert (
        listed_response.json()[0]["account_id"] == saved_response.json()["account_id"]
    )
    assert tested_response.status_code == 200
    assert tested_response.json()["status"] == "available"
    assert "sessionid\tlogin-token" in tested_cookie_files[0]
    assert deleted_response.status_code == 204
    assert missing_response.json() is None


def test_failed_douyin_account_test_marks_cookie_as_expired(monkeypatch, tmp_path):
    def reject_metadata(*_: object):
        raise DownloadFailure("保存的登录状态已失效，请重新登录")

    monkeypatch.setattr(api, "read_download_metadata", reject_metadata)
    account_store = DownloadAccountStore(
        tmp_path / "config",
        MemoryDownloadAccountSecretStore(),
    )
    account_store.save(SourcePlatform.DOUYIN, "sessionid=expired-token")
    app = api.create_app(
        Settings(library_path=tmp_path / "library"),
        download_account_store=account_store,
    )

    with TestClient(app) as client:
        response = client.post("/api/download-accounts/douyin/test", json={})
        account_response = client.get("/api/download-accounts/douyin")

    assert response.status_code == 401
    assert account_response.json()["status"] == "expired"


@pytest.mark.parametrize(
    ("platform", "source_url", "cookie_header"),
    [
        (
            SourcePlatform.BILIBILI,
            "https://www.bilibili.com/video/BV1xx411c7mD",
            "SESSDATA=browser-login-token",
        ),
        (
            SourcePlatform.DOUYIN,
            "https://www.douyin.com/video/6961737553342991651",
            "sessionid=browser-login-token",
        ),
        (
            SourcePlatform.YOUTUBE,
            "https://www.youtube.com/watch?v=BaW_jenozKc",
            "SAPISID=browser-login-token",
        ),
    ],
)
def test_platform_account_can_be_imported_from_a_logged_in_browser(
    monkeypatch,
    tmp_path,
    platform: SourcePlatform,
    source_url: str,
    cookie_header: str,
):
    import_calls: list[tuple[SourcePlatform, DownloadCookieBrowser, str]] = []

    def import_cookie(
        platform: SourcePlatform,
        browser: DownloadCookieBrowser,
        source_url: str,
    ) -> str:
        import_calls.append((platform, browser, source_url))
        return cookie_header

    monkeypatch.setattr(api, "import_cookie_from_browser", import_cookie)
    account_store = DownloadAccountStore(
        tmp_path / "config",
        MemoryDownloadAccountSecretStore(),
    )
    app = api.create_app(
        Settings(library_path=tmp_path / "library"),
        download_account_store=account_store,
    )

    with TestClient(app) as client:
        response = client.post(
            f"/api/download-accounts/{platform.value}/import-browser",
            json={
                "browser": "edge",
                "source_url": source_url,
            },
        )

    assert response.status_code == 200
    assert response.json()["status"] == "available"
    assert import_calls == [
        (
            platform,
            DownloadCookieBrowser.EDGE,
            source_url,
        )
    ]


def test_platform_account_can_login_in_a_dedicated_browser(monkeypatch, tmp_path):
    capture_calls: list[SourcePlatform] = []

    def capture_login(platform: SourcePlatform, _: object) -> str:
        capture_calls.append(platform)
        return "sessionid=dedicated-login-token; ttwid=device-token"

    def read_metadata(*_: object) -> DownloadMetadata:
        return DownloadMetadata(
            source_video_id="6961737553342991651",
            title="示例抖音视频",
            author_name="示例作者",
            description=None,
            duration_seconds=19,
            width=1080,
            height=1920,
            thumbnail_url=None,
        )

    monkeypatch.setattr(api, "read_download_metadata", read_metadata)
    account_store = DownloadAccountStore(
        tmp_path / "config",
        MemoryDownloadAccountSecretStore(),
    )
    app = api.create_app(
        Settings(library_path=tmp_path / "library"),
        download_account_store=account_store,
        download_account_login_capture=capture_login,
    )

    with TestClient(app) as client:
        created_response = client.post(
            "/api/download-accounts/douyin/login-sessions"
        )
        login_id = created_response.json()["login_id"]
        session_response = created_response
        for _ in range(20):
            session_response = client.get(
                f"/api/download-account-login-sessions/{login_id}"
            )
            if session_response.json()["stage"] == "complete":
                break
            time.sleep(0.01)
        deleted_response = client.delete(
            f"/api/download-account-login-sessions/{login_id}"
        )

    assert created_response.status_code == 202
    assert UUID(hex=login_id.removeprefix("login-")).version == 7
    assert session_response.json()["stage"] == "complete"
    assert session_response.json()["account"]["status"] == "available"
    assert capture_calls == [SourcePlatform.DOUYIN]
    assert deleted_response.status_code == 204


def test_dedicated_browser_login_can_be_cancelled(tmp_path):
    capture_started = Event()

    def wait_for_cancellation(_: SourcePlatform, cancel_event: Event) -> str:
        capture_started.set()
        cancel_event.wait(timeout=1)
        raise DownloadAccountLoginCancelled("账号登录已取消")

    app = api.create_app(
        Settings(library_path=tmp_path / "library"),
        download_account_store=DownloadAccountStore(
            tmp_path / "config",
            MemoryDownloadAccountSecretStore(),
        ),
        download_account_login_capture=wait_for_cancellation,
    )

    with TestClient(app) as client:
        created_response = client.post(
            "/api/download-accounts/bilibili/login-sessions"
        )
        assert capture_started.wait(timeout=1)
        deleted_response = client.delete(
            "/api/download-account-login-sessions/"
            f"{created_response.json()['login_id']}"
        )

    assert created_response.status_code == 202
    assert deleted_response.status_code == 204
