from pathlib import Path

from fastapi.testclient import TestClient

from openvideo.core.models import MediaAsset, MediaAssetStatus
from openvideo.settings import Settings
from openvideo.ui.api import create_app


ASSET_ID = "asset-0123456789abcdef0123456789abcdef"
CONTENT = bytes(range(100))


def create_client(tmp_path: Path) -> TestClient:
    app = create_app(Settings(library_path=tmp_path))
    client = TestClient(app)
    client.__enter__()
    library = app.state.library
    asset_directory = library.asset_directory(ASSET_ID)
    asset_directory.mkdir(parents=True, exist_ok=True)
    (asset_directory / "playback.mp4").write_bytes(CONTENT)
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="https://www.bilibili.com/video/BV1xx411c7mD",
            source_video_id="BV1xx411c7mD",
            title="测试视频",
            status=MediaAssetStatus.READY,
            playback_path="playback.mp4",
        )
    )
    return client


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
