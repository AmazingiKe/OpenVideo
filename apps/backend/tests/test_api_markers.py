from pathlib import Path

from fastapi.testclient import TestClient

from openvideo.core.media_models import MediaAsset, MediaAssetStatus, SourcePlatform
from openvideo.core.library import MediaLibrary
from openvideo.settings import Settings
from openvideo.ui.api import create_app


ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"


def create_client(tmp_path: Path) -> TestClient:
    library = MediaLibrary.initialize_directory(tmp_path)
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="https://www.bilibili.com/video/BV1xx411c7mD",
            source_platform=SourcePlatform.BILIBILI,
            source_video_id="BV1xx411c7mD",
            title="测试视频",
            status=MediaAssetStatus.READY,
        )
    )
    library.close()
    return TestClient(create_app(Settings(library_path=tmp_path)))


def test_marker_lifecycle_persists_with_its_media_asset(tmp_path: Path):
    with create_client(tmp_path) as client:
        created_response = client.post(
            f"/api/media/assets/{ASSET_ID}/markers",
            json={"time_seconds": 12.5, "tags": ["重点"]},
        )
        assert created_response.status_code == 201
        marker = created_response.json()
        assert marker["marker_id"].startswith("marker-")
        assert marker["asset_id"] == ASSET_ID
        assert marker["time_seconds"] == 12.5
        assert marker["tags"] == ["重点"]

        marker_id = marker["marker_id"]
        updated_response = client.patch(
            f"/api/media/assets/{ASSET_ID}/markers/{marker_id}",
            json={"tags": ["关键帧", "待核对"]},
        )
        assert updated_response.status_code == 200
        assert updated_response.json()["tags"] == ["关键帧", "待核对"]

    restored_app = create_app(Settings(library_path=tmp_path))
    with TestClient(restored_app) as restored_client:
        listed_response = restored_client.get(f"/api/media/assets/{ASSET_ID}/markers")
        assert listed_response.status_code == 200
        assert listed_response.json() == [
            {
                "marker_id": marker_id,
                "asset_id": ASSET_ID,
                "time_seconds": 12.5,
                "tags": ["关键帧", "待核对"],
            }
        ]

        deleted_response = restored_client.delete(
            f"/api/media/assets/{ASSET_ID}/markers/{marker_id}"
        )
        assert deleted_response.status_code == 204
        assert restored_client.get(f"/api/media/assets/{ASSET_ID}/markers").json() == []


def test_markers_reject_missing_assets_and_invalid_times(tmp_path: Path):
    with create_client(tmp_path) as client:
        missing_response = client.post(
            "/api/media/assets/01890f4c-7a2b-7cc2-98c4-dc0c0c073990/markers",
            json={"time_seconds": 1, "tags": []},
        )
        invalid_response = client.post(
            f"/api/media/assets/{ASSET_ID}/markers",
            json={"time_seconds": -1, "tags": []},
        )

    assert missing_response.status_code == 404
    assert invalid_response.status_code == 422
