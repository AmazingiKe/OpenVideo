from fastapi.testclient import TestClient
import pytest
import time
from threading import Event
from unittest.mock import AsyncMock
from uuid import UUID

from openvideo.core.media_models import MediaAssetStatus, SourcePlatform
from openvideo import download_manager
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


def test_download_folder_assignment_defaults_and_preserves_duplicates(
    monkeypatch,
    tmp_path,
):
    monkeypatch.setattr(download_manager.DownloadManager, "start", lambda *_: None)
    app = api.create_app(Settings(library_path=tmp_path))

    with TestClient(app) as client:
        courses = client.post(
            "/api/library/folders",
            json={"name": "课程", "parent_id": None},
        ).json()
        archive = client.post(
            "/api/library/folders",
            json={"name": "归档", "parent_id": None},
        ).json()
        first = client.post(
            "/api/downloads",
            json={
                "source_urls": [
                    "https://www.bilibili.com/video/BV1xx411c7mD"
                ],
                "folder_id": courses["folder_id"],
            },
        )
        duplicate = client.post(
            "/api/downloads",
            json={
                "source_urls": [
                    "https://www.bilibili.com/video/BV1xx411c7mD"
                ],
                "folder_id": archive["folder_id"],
            },
        )
        uncategorized = client.post(
            "/api/downloads",
            json={
                "source_urls": [
                    "https://www.youtube.com/watch?v=BaW_jenozKc"
                ]
            },
        )
        assets = client.get("/api/media/assets").json()

    assert first.status_code == 202
    assert duplicate.status_code == 202
    assert uncategorized.status_code == 202
    assert duplicate.json()[0]["asset_id"] == first.json()[0]["asset_id"]
    by_id = {asset["asset_id"]: asset for asset in assets}
    assert by_id[first.json()[0]["asset_id"]]["folder_id"] == courses["folder_id"]
    assert by_id[uncategorized.json()[0]["asset_id"]]["folder_id"] is None


def test_download_persists_selected_video_quality(monkeypatch, tmp_path):
    monkeypatch.setattr(download_manager.DownloadManager, "start", lambda *_: None)
    app = api.create_app(Settings(library_path=tmp_path))

    with TestClient(app) as client:
        response = client.post(
            "/api/downloads",
            json={
                "source_urls": [
                    "https://www.youtube.com/watch?v=BaW_jenozKc"
                ],
                "video_quality": "1080p",
            },
        )
        history = client.get("/api/downloads?limit=50")

    assert response.status_code == 202
    assert response.json()[0]["video_quality"] == "1080p"
    assert history.json()[0]["video_quality"] == "1080p"


def test_playlist_download_automatically_creates_and_reuses_folder(
    monkeypatch,
    tmp_path,
):
    monkeypatch.setattr(download_manager.DownloadManager, "start", lambda *_: None)
    app = api.create_app(Settings(library_path=tmp_path))

    with TestClient(app) as client:
        first = client.post(
            "/api/downloads",
            json={
                "source_urls": [
                    "https://www.bilibili.com/video/BV1xx411c7mD"
                ],
                "automatic_folder_name": "课程/第一季",
            },
        )
        second = client.post(
            "/api/downloads",
            json={
                "source_urls": [
                    "https://www.youtube.com/watch?v=BaW_jenozKc"
                ],
                "automatic_folder_name": "课程/第一季",
            },
        )
        folders = client.get("/api/library/folders").json()
        assets = client.get("/api/media/assets").json()

    assert first.status_code == 202
    assert second.status_code == 202
    assert len(folders) == 1
    assert folders[0]["name"] == "课程／第一季"
    assert {asset["folder_id"] for asset in assets} == {folders[0]["folder_id"]}


def test_existing_ready_download_moves_to_requested_folder(monkeypatch, tmp_path):
    monkeypatch.setattr(download_manager.DownloadManager, "start", lambda *_: None)
    app = api.create_app(Settings(library_path=tmp_path))

    with TestClient(app) as client:
        created = client.post(
            "/api/downloads",
            json={
                "source_urls": [
                    "https://www.bilibili.com/video/BV1xx411c7mD"
                ]
            },
        ).json()[0]
        app.state.download_manager._fail(created["job_id"], "模拟原任务已结束")
        asset = app.state.library.get(created["asset_id"])
        asset.status = MediaAssetStatus.READY
        app.state.library.save(asset)
        folder = client.post(
            "/api/library/folders",
            json={"name": "课程", "parent_id": None},
        ).json()

        repeated = client.post(
            "/api/downloads",
            json={
                "source_urls": [
                    "https://www.bilibili.com/video/BV1xx411c7mD"
                ],
                "folder_id": folder["folder_id"],
                "assign_folder": True,
            },
        )
        moved = client.get(f"/api/media/assets/{created['asset_id']}").json()

    assert repeated.status_code == 202
    assert repeated.json()[0]["stage"] == "complete"
    assert moved["folder_id"] == folder["folder_id"]


def test_failed_download_reuses_asset_for_a_new_job(monkeypatch, tmp_path):
    monkeypatch.setattr(download_manager.DownloadManager, "start", lambda *_: None)
    app = api.create_app(Settings(library_path=tmp_path))

    with TestClient(app) as client:
        first_response = client.post(
            "/api/downloads",
            json={
                "source_urls": [
                    "https://www.bilibili.com/video/BV1xx411c7mD"
                ]
            },
        )
        first_job = first_response.json()[0]
        app.state.download_manager._fail(first_job["job_id"], "测试下载失败")

        retry_response = client.post(
            "/api/downloads",
            json={
                "source_urls": [
                    "https://www.bilibili.com/video/BV1xx411c7mD"
                ]
            },
        )
        assets = client.get("/api/media/assets").json()

    retry_job = retry_response.json()[0]
    assert retry_response.status_code == 202
    assert retry_job["job_id"] != first_job["job_id"]
    assert retry_job["asset_id"] == first_job["asset_id"]
    assert retry_job["stage"] == "pending"
    assert len(assets) == 1
    assert assets[0]["status"] == "pending"
    assert assets[0]["error_message"] is None


def test_failed_download_can_be_retried_by_job_id(monkeypatch, tmp_path):
    monkeypatch.setattr(download_manager.DownloadManager, "start", lambda *_: None)
    app = api.create_app(Settings(library_path=tmp_path))

    with TestClient(app) as client:
        first_job = client.post(
            "/api/downloads",
            json={
                "source_urls": [
                    "https://www.bilibili.com/video/BV1xx411c7mD"
                ],
                "video_quality": "720p",
            },
        ).json()[0]
        app.state.download_manager._fail(first_job["job_id"], "测试下载失败")

        retry_response = client.post(
            f"/api/downloads/{first_job['job_id']}/retry"
        )
        invalid_response = client.post(
            f"/api/downloads/{retry_response.json()['job_id']}/retry"
        )
        missing_response = client.post(
            "/api/downloads/job-019c0000000070008000000000000000/retry"
        )

    retry_job = retry_response.json()
    assert retry_response.status_code == 202
    assert retry_job["job_id"] != first_job["job_id"]
    assert retry_job["asset_id"] == first_job["asset_id"]
    assert retry_job["video_quality"] == "720p"
    assert retry_job["stage"] == "pending"
    assert invalid_response.status_code == 409
    assert invalid_response.json()["detail"] == "只有失败的下载任务可以重新下载"
    assert missing_response.status_code == 404


def test_interrupted_download_can_be_retried_after_restart(monkeypatch, tmp_path):
    monkeypatch.setattr(download_manager.DownloadManager, "start", lambda *_: None)
    settings = Settings(library_path=tmp_path)
    app = api.create_app(settings)

    with TestClient(app) as client:
        first_response = client.post(
            "/api/downloads",
            json={
                "source_urls": [
                    "https://www.bilibili.com/video/BV1xx411c7mD"
                ]
            },
        )
        first_job = first_response.json()[0]

    restarted_app = api.create_app(settings)
    with TestClient(restarted_app) as client:
        retry_response = client.post(
            "/api/downloads",
            json={
                "source_urls": [
                    "https://www.bilibili.com/video/BV1xx411c7mD"
                ]
            },
        )
        history = client.get("/api/downloads?limit=50").json()
        assets = client.get("/api/media/assets").json()

    retry_job = retry_response.json()[0]
    history_by_id = {job["job_id"]: job for job in history}
    assert retry_response.status_code == 202
    assert retry_job["job_id"] != first_job["job_id"]
    assert retry_job["asset_id"] == first_job["asset_id"]
    assert retry_job["stage"] == "pending"
    assert history_by_id[first_job["job_id"]]["stage"] == "failed"
    assert history_by_id[first_job["job_id"]]["error_message"] == (
        "应用重启中断了下载任务"
    )
    assert len(assets) == 1
    assert assets[0]["status"] == "pending"
    assert assets[0]["error_message"] is None


def test_asset_delete_keeps_files_when_a_related_task_cannot_stop(
    monkeypatch,
    tmp_path,
):
    monkeypatch.setattr(download_manager.DownloadManager, "start", lambda *_: None)
    app = api.create_app(Settings(library_path=tmp_path))

    with TestClient(app) as client:
        created = client.post(
            "/api/downloads",
            json={
                "source_urls": [
                    "https://www.bilibili.com/video/BV1xx411c7mD"
                ]
            },
        ).json()[0]
        asset_directory = tmp_path / "assets" / created["asset_id"]
        app.state.download_manager.cancel_assets = AsyncMock(return_value=False)

        response = client.delete(f"/api/media/assets/{created['asset_id']}")
        invalid_response = client.delete("/api/media/assets/not-an-asset-id")

    assert response.status_code == 409
    assert invalid_response.status_code == 404
    assert asset_directory.is_dir()


def test_download_history_restores_title_and_events_after_restart(
    monkeypatch,
    tmp_path,
):
    def fail_after_metadata(
        _source_url,
        _platform,
        _asset_directory,
        _configured_ffmpeg_path,
        _project_bin_dir,
        _on_progress,
        on_stage,
        on_metadata,
        **_options,
    ):
        metadata = DownloadMetadata(
            source_video_id="BaW_jenozKc",
            title="Blender 角色绑定完整教程",
            author_name="OpenVideo",
            description=None,
            duration_seconds=120,
            width=1920,
            height=1080,
            thumbnail_url=None,
        )
        on_stage("正在读取视频信息")
        on_metadata(metadata)
        on_stage("正在下载视频和音频")
        raise DownloadFailure("测试下载失败")

    monkeypatch.setattr(download_manager, "download_video", fail_after_metadata)
    settings = Settings(library_path=tmp_path)
    app = api.create_app(settings)
    with TestClient(app) as client:
        created_response = client.post(
            "/api/downloads",
            json={"source_urls": ["https://www.youtube.com/watch?v=BaW_jenozKc"]},
        )
        job_id = created_response.json()[0]["job_id"]
        task_response = created_response
        for _ in range(50):
            task_response = client.get(f"/api/downloads/{job_id}")
            if task_response.json()["stage"] == "failed":
                break
            time.sleep(0.01)

    assert created_response.status_code == 202
    assert task_response.json()["name"] == "Blender 角色绑定完整教程"
    messages = [event["message"] for event in task_response.json()["events"]]
    assert "已识别视频：Blender 角色绑定完整教程" in messages
    assert task_response.json()["events"][-1]["error_message"] == "测试下载失败"
    reading_events = [
        event
        for event in task_response.json()["events"]
        if event["message"] == "正在读取视频信息"
    ]
    assert len(reading_events) == 1
    assert reading_events[0]["stage"] == "reading_metadata"
    identified_event = next(
        event
        for event in task_response.json()["events"]
        if event["message"] == "已识别视频：Blender 角色绑定完整教程"
    )
    assert identified_event["stage"] == "reading_metadata"
    downloading_event = next(
        event
        for event in task_response.json()["events"]
        if event["message"] == "正在下载视频和音频"
    )
    assert downloading_event["stage"] == "downloading"

    restarted_app = api.create_app(settings)
    with TestClient(restarted_app) as client:
        history_response = client.get("/api/downloads?limit=50")

    assert history_response.status_code == 200
    assert history_response.json()[0]["job_id"] == job_id
    assert history_response.json()[0]["name"] == "Blender 角色绑定完整教程"
    assert history_response.json()[0]["events"] == task_response.json()["events"]


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
