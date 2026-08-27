from pathlib import Path

from fastapi.testclient import TestClient

from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import MediaAsset, MediaAssetStatus, SourcePlatform
from openvideo.core.thumbnails import SCRUB_PROXY_FILE_NAME
from openvideo.settings import Settings
from openvideo.ui import media_routes
from openvideo.ui.api import create_app

ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"
CONTENT = bytes(range(100))


def create_client(tmp_path: Path) -> TestClient:
    library = MediaLibrary.initialize_directory(tmp_path)
    asset_directory = library.asset_directory(ASSET_ID)
    asset_directory.mkdir(parents=True, exist_ok=True)
    (asset_directory / "playback.mp4").write_bytes(CONTENT)
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="https://www.bilibili.com/video/BV1xx411c7mD",
            source_platform=SourcePlatform.BILIBILI,
            source_video_id="BV1xx411c7mD",
            title="测试视频",
            status=MediaAssetStatus.READY,
            playback_path="playback.mp4",
        )
    )
    library.close()
    return TestClient(create_app(Settings(library_path=tmp_path)))


def test_serves_full_video(tmp_path: Path):
    with create_client(tmp_path) as client:
        response = client.get(f"/api/media/assets/{ASSET_ID}/stream")
    assert response.status_code == 200
    assert response.content == CONTENT
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["content-length"] == "100"


def test_serves_single_range_and_head(tmp_path: Path):
    with create_client(tmp_path) as client:
        response = client.get(
            f"/api/media/assets/{ASSET_ID}/stream",
            headers={"Range": "bytes=10-19"},
        )
        head_response = client.head(
            f"/api/media/assets/{ASSET_ID}/stream",
            headers={"Range": "bytes=-5"},
        )
    assert response.status_code == 206
    assert response.content == CONTENT[10:20]
    assert response.headers["content-range"] == "bytes 10-19/100"
    assert head_response.status_code == 206
    assert head_response.content == b""
    assert head_response.headers["content-range"] == "bytes 95-99/100"


def test_returns_416_for_unsatisfied_range(tmp_path: Path):
    with create_client(tmp_path) as client:
        response = client.get(
            f"/api/media/assets/{ASSET_ID}/stream",
            headers={"Range": "bytes=500-600"},
        )
    assert response.status_code == 416
    assert response.headers["content-range"] == "bytes */100"


def test_generates_and_streams_scrub_preview(monkeypatch, tmp_path: Path):
    generated_content = b"scrub-preview"
    generated_from: list[Path] = []

    def generate_proxy(
        video_path: Path,
        asset_directory: Path,
        configured_ffmpeg_path: str | None,
        project_bin_dir: Path | None,
    ) -> Path:
        generated_from.append(video_path)
        proxy_file = asset_directory / SCRUB_PROXY_FILE_NAME
        proxy_file.write_bytes(generated_content)
        return proxy_file

    monkeypatch.setattr(media_routes, "generate_scrub_proxy", generate_proxy)

    with create_client(tmp_path) as client:
        asset_response = client.get(f"/api/media/assets/{ASSET_ID}")
        preview_url = asset_response.json()["scrub_preview_url"]
        response = client.get(preview_url, headers={"Range": "bytes=2-6"})

    assert preview_url == f"/api/media/assets/{ASSET_ID}/scrub-preview"
    assert generated_from == [tmp_path / "assets" / ASSET_ID / "playback.mp4"]
    assert response.status_code == 206
    assert response.content == generated_content[2:7]
    assert response.headers["content-range"] == "bytes 2-6/13"
