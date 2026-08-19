from pathlib import Path

from openvideo.core.library import MediaLibrary
from openvideo.core.models import MediaAsset, MediaAssetStatus


ASSET_ID = "asset-0123456789abcdef0123456789abcdef"


def test_saves_and_recovers_ready_asset(tmp_path: Path):
    library = MediaLibrary(tmp_path)
    library.load()
    asset_directory = library.asset_directory(ASSET_ID)
    asset_directory.mkdir(parents=True, exist_ok=True)
    (asset_directory / "playback.mp4").write_bytes(b"video")
    asset = MediaAsset(
        asset_id=ASSET_ID,
        source_url="https://www.bilibili.com/video/BV1xx411c7mD",
        source_video_id="BV1xx411c7mD",
        title="测试视频",
        status=MediaAssetStatus.READY,
        playback_path="playback.mp4",
    )
    library.save(asset)

    recovered = MediaLibrary(tmp_path)
    recovered.load()
    loaded_asset = recovered.get(ASSET_ID)
    assert loaded_asset is not None
    assert loaded_asset.title == "测试视频"
    response = recovered.response_for(loaded_asset)
    assert response.playback_url == f"/api/media/assets/{ASSET_ID}/stream"
    assert "playback.mp4" not in response.model_dump_json()
    assert str(tmp_path) not in response.model_dump_json()


def test_marks_interrupted_asset_as_failed(tmp_path: Path):
    library = MediaLibrary(tmp_path)
    library.load()
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="https://b23.tv/AbC123",
            status=MediaAssetStatus.DOWNLOADING,
        )
    )

    recovered = MediaLibrary(tmp_path)
    recovered.load()
    asset = recovered.get(ASSET_ID)
    assert asset is not None
    assert asset.status == MediaAssetStatus.FAILED
    assert asset.error_message
