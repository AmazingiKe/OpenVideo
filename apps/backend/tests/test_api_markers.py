from pathlib import Path

from fastapi.testclient import TestClient

from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import MediaAsset, MediaAssetStatus, SourcePlatform
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
            duration_seconds=60,
            status=MediaAssetStatus.READY,
        )
    )
    library.close()
    return TestClient(create_app(Settings(library_path=tmp_path)))


def test_marker_lifecycle_persists_point_and_range_fields(tmp_path: Path):
    with create_client(tmp_path) as client:
        created_response = client.post(
            f"/api/media/assets/{ASSET_ID}/markers",
            json={
                "start_seconds": 12.5,
                "end_seconds": None,
                "title": "结论",
                "tags": ["重点"],
            },
        )
        assert created_response.status_code == 201
        marker = created_response.json()
        assert marker["marker_id"].startswith("marker-")
        assert marker["asset_id"] == ASSET_ID
        assert marker["start_seconds"] == 12.5
        assert marker["end_seconds"] is None
        assert marker["title"] == "结论"
        assert marker["tags"] == ["重点"]

        marker_id = marker["marker_id"]
        updated_response = client.patch(
            f"/api/media/assets/{ASSET_ID}/markers/{marker_id}",
            json={
                "start_seconds": 10,
                "end_seconds": 18,
                "title": "完整结论",
                "tags": ["关键帧", "待核对"],
            },
        )
        assert updated_response.status_code == 200
        assert updated_response.json()["end_seconds"] == 18

    with TestClient(create_app(Settings(library_path=tmp_path))) as restored_client:
        assert restored_client.get(f"/api/media/assets/{ASSET_ID}/markers").json() == [
            {
                "marker_id": marker_id,
                "asset_id": ASSET_ID,
                "start_seconds": 10,
                "end_seconds": 18,
                "title": "完整结论",
                "tags": ["关键帧", "待核对"],
            }
        ]
        assert (
            restored_client.delete(
                f"/api/media/assets/{ASSET_ID}/markers/{marker_id}"
            ).status_code
            == 204
        )


def test_markers_reject_missing_assets_and_invalid_ranges(tmp_path: Path):
    point = {"start_seconds": 1, "end_seconds": None, "title": "", "tags": []}
    with create_client(tmp_path) as client:
        missing_response = client.post(
            "/api/media/assets/01890f4c-7a2b-7cc2-98c4-dc0c0c073990/markers",
            json=point,
        )
        negative_response = client.post(
            f"/api/media/assets/{ASSET_ID}/markers",
            json={**point, "start_seconds": -1},
        )
        reversed_response = client.post(
            f"/api/media/assets/{ASSET_ID}/markers",
            json={**point, "start_seconds": 12, "end_seconds": 10},
        )
        outside_response = client.post(
            f"/api/media/assets/{ASSET_ID}/markers",
            json={**point, "start_seconds": 55, "end_seconds": 65},
        )

    assert missing_response.status_code == 404
    assert negative_response.status_code == 422
    assert reversed_response.status_code == 422
    assert outside_response.status_code == 422
