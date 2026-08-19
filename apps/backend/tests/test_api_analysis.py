from pathlib import Path

from fastapi.testclient import TestClient

from openvideo.core.analysis_models import Transcript
from openvideo.core.models import MediaAsset, MediaAssetStatus, SourcePlatform
from openvideo.settings import Settings
from openvideo.ui.api import create_app

import openvideo.application as application_module


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
            source_platform=SourcePlatform.BILIBILI,
            source_video_id="BV1xx411c7mD",
            title="测试视频",
            status=MediaAssetStatus.READY,
            playback_path="playback.mp4",
        )
    )
    return client


def test_analyze_returns_404_for_missing_asset(tmp_path: Path):
    with create_client(tmp_path) as client:
        response = client.post("/api/media/assets/asset-00000000000000000000000000000000/analyze")
    assert response.status_code == 404


def test_transcript_returns_404_when_missing(tmp_path: Path):
    with create_client(tmp_path) as client:
        response = client.get(f"/api/media/assets/{ASSET_ID}/transcript")
    assert response.status_code == 404


def test_analyze_creates_job(tmp_path: Path, monkeypatch):
    def fake_transcribe(*args, **kwargs) -> Transcript:
        return Transcript(asset_id=ASSET_ID, language="zh", segments=[])

    monkeypatch.setattr(application_module, "transcribe_media", fake_transcribe)
    with create_client(tmp_path) as client:
        response = client.post(f"/api/media/assets/{ASSET_ID}/analyze")

    assert response.status_code == 202
    job = response.json()
    assert job["asset_id"] == ASSET_ID
    assert job["job_id"].startswith("analysis-")
