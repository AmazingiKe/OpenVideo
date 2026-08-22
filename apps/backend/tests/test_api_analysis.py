from pathlib import Path

from fastapi.testclient import TestClient

from openvideo.core.analysis_models import Transcript, TranscriptSegment
from openvideo.core.models import MediaAsset, MediaAssetStatus, MediaSegment, SourcePlatform
from openvideo.core.library import MediaLibrary
from openvideo.settings import Settings
from openvideo.ui.api import create_app

import openvideo.application as application_module


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


def test_analyze_returns_404_for_missing_asset(tmp_path: Path):
    with create_client(tmp_path) as client:
        response = client.post("/api/media/assets/01890f4c-7a2b-7cc2-98c4-dc0c0c073990/analyze")
    assert response.status_code == 404


def test_transcript_returns_404_when_missing(tmp_path: Path):
    with create_client(tmp_path) as client:
        response = client.get(f"/api/media/assets/{ASSET_ID}/transcript")
    assert response.status_code == 404


def test_transcript_segment_update_is_persisted(tmp_path: Path):
    with create_client(tmp_path) as client:
        client.app.state.library.save_transcript(
            Transcript(
                asset_id=ASSET_ID,
                language="zh",
                segments=[TranscriptSegment(start_seconds=1, end_seconds=3, text="错误文字")],
            )
        )
        response = client.patch(
            f"/api/media/assets/{ASSET_ID}/transcript/segments/0",
            json={"text": "修正后的文字"},
        )
        reloaded = client.get(f"/api/media/assets/{ASSET_ID}/transcript")

    assert response.status_code == 200
    assert response.json()["segments"][0]["text"] == "修正后的文字"
    assert reloaded.json()["segments"][0]["text"] == "修正后的文字"


def test_transcript_segment_update_rejects_blank_text(tmp_path: Path):
    with create_client(tmp_path) as client:
        client.app.state.library.save_transcript(
            Transcript(
                asset_id=ASSET_ID,
                segments=[TranscriptSegment(start_seconds=1, end_seconds=3, text="原文字")],
            )
        )
        response = client.patch(
            f"/api/media/assets/{ASSET_ID}/transcript/segments/0",
            json={"text": "   "},
        )

    assert response.status_code == 422


def test_analyze_creates_job(tmp_path: Path):
    with create_client(tmp_path) as client:
        client.app.state.library.save_transcript(Transcript(asset_id=ASSET_ID))
        response = client.post(f"/api/media/assets/{ASSET_ID}/analyze")

    assert response.status_code == 202
    job = response.json()
    assert job["asset_id"] == ASSET_ID
    assert job["job_id"].startswith("job-")
    assert job["operation"] == "analysis"


def test_marker_analysis_records_selected_marker_scope(tmp_path: Path):
    with create_client(tmp_path) as client:
        client.app.state.library.save_transcript(Transcript(asset_id=ASSET_ID))
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


def test_analysis_requires_transcription(tmp_path: Path):
    with create_client(tmp_path) as client:
        response = client.post(f"/api/media/assets/{ASSET_ID}/analyze")

    assert response.status_code == 409


def test_transcription_creates_independent_job(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(
        application_module,
        "transcribe_media",
        lambda *args, **kwargs: Transcript(asset_id=ASSET_ID),
    )
    with create_client(tmp_path) as client:
        response = client.post(f"/api/media/assets/{ASSET_ID}/transcribe")

    assert response.status_code == 202
    assert response.json()["operation"] == "transcription"
    assert response.json()["job_id"].startswith("job-")


def test_segments_returns_empty_when_missing(tmp_path: Path):
    with create_client(tmp_path) as client:
        response = client.get(f"/api/media/assets/{ASSET_ID}/segments")
    assert response.status_code == 200
    assert response.json() == []


def test_segments_and_frame_roundtrip(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    asset_directory = library.asset_directory(ASSET_ID)
    asset_directory.mkdir(parents=True, exist_ok=True)
    (asset_directory / "playback.mp4").write_bytes(CONTENT)
    frames_directory = asset_directory / "artifacts" / "frames"
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
                key_frame_paths=["artifacts/frames/frame.jpg"],
                visual_description="画面描述",
            )
        ]
    )
    library.close()
    app = create_app(Settings(library_path=tmp_path))

    with TestClient(app) as client:
        segments_response = client.get(f"/api/media/assets/{ASSET_ID}/segments")
        frame_response = client.get(
            f"/api/media/assets/{ASSET_ID}/frames/artifacts/frames/frame.jpg"
        )

    assert segments_response.status_code == 200
    segments = segments_response.json()
    assert len(segments) == 1
    assert segments[0]["visual_description"] == "画面描述"
    assert frame_response.status_code == 200
    assert frame_response.content == b"jpeg-bytes"
