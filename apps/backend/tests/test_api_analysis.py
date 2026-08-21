from pathlib import Path

from fastapi.testclient import TestClient

from openvideo.core.analysis_models import Transcript
from openvideo.core.models import MediaAsset, MediaAssetStatus, MediaSegment, SourcePlatform
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


def test_marker_analysis_records_selected_marker_scope(tmp_path: Path, monkeypatch):
    def fake_transcribe(*args, **kwargs) -> Transcript:
        return Transcript(asset_id=ASSET_ID, language="zh", segments=[])

    monkeypatch.setattr(application_module, "transcribe_media", fake_transcribe)
    with create_client(tmp_path) as client:
        marker = client.post(
            f"/api/media/assets/{ASSET_ID}/markers",
            json={"time_seconds": 12.5, "tags": ["公式"]},
        ).json()
        response = client.post(
            f"/api/media/assets/{ASSET_ID}/analyze",
            json={"mode": "markers", "marker_ids": [marker["marker_id"]], "force": True},
        )

    assert response.status_code == 202
    job = response.json()
    assert job["mode"] == "markers"
    assert job["marker_ids"] == [marker["marker_id"]]


def test_segments_returns_empty_when_missing(tmp_path: Path):
    with create_client(tmp_path) as client:
        response = client.get(f"/api/media/assets/{ASSET_ID}/segments")
    assert response.status_code == 200
    assert response.json() == []


def test_segments_and_frame_roundtrip(tmp_path: Path):
    app = create_app(Settings(library_path=tmp_path))
    library = app.state.library
    library.load()
    asset_directory = library.asset_directory(ASSET_ID)
    asset_directory.mkdir(parents=True, exist_ok=True)
    (asset_directory / "playback.mp4").write_bytes(CONTENT)
    frames_directory = asset_directory / ".analysis" / "frames"
    frames_directory.mkdir(parents=True, exist_ok=True)
    (frames_directory / "frame.jpg").write_bytes(b"jpeg-bytes")
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
    library.save_segments(
        ASSET_ID,
        [
            MediaSegment(
                segment_id="segment-0123456789abcdef0123456789abcdef",
                asset_id=ASSET_ID,
                start_seconds=0,
                end_seconds=30,
                transcript_text="重点内容",
                key_frame_paths=[".analysis/frames/frame.jpg"],
                visual_description="画面描述",
            )
        ]
    )

    with TestClient(app) as client:
        segments_response = client.get(f"/api/media/assets/{ASSET_ID}/segments")
        frame_response = client.get(
            f"/api/media/assets/{ASSET_ID}/frames/.analysis/frames/frame.jpg"
        )

    assert segments_response.status_code == 200
    segments = segments_response.json()
    assert len(segments) == 1
    assert segments[0]["visual_description"] == "画面描述"
    assert frame_response.status_code == 200
    assert frame_response.content == b"jpeg-bytes"
