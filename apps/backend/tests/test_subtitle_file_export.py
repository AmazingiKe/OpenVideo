from collections.abc import Iterator
from pathlib import Path
from urllib.parse import unquote

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import (
    MediaAsset,
    MediaAssetStatus,
    MediaType,
    SourcePlatform,
)
from openvideo.core.transcription_models import Transcript, TranscriptSegment
from openvideo.settings import Settings
from openvideo.tools import subtitle_export
from openvideo.ui.media_routes import register_media_routes


ASSET_ID = str(uuid7())
SUBTITLE_URL = f"/api/media/assets/{ASSET_ID}/subtitle-file"


@pytest.fixture
def subtitle_client(tmp_path: Path) -> Iterator[tuple[TestClient, MediaLibrary]]:
    library = MediaLibrary.initialize_directory(tmp_path)
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            title="中文课程 🎬",
            source_platform=SourcePlatform.LOCAL,
            source_url="local://subtitle-test",
            status=MediaAssetStatus.READY,
            duration_seconds=10,
        )
    )
    library.save_transcript(
        Transcript(
            asset_id=ASSET_ID,
            segments=[
                TranscriptSegment(start_seconds=1, end_seconds=2, text="最新字幕")
            ],
        )
    )
    app = FastAPI()
    register_media_routes(app, lambda: library, Settings())
    with TestClient(app) as client:
        yield client, library
    library.close()


@pytest.mark.parametrize(
    ("file_format", "content_type", "expected"),
    [
        ("srt", "application/x-subrip", "1\n00:00:01,000 --> 00:00:02,000\n最新字幕\n"),
        ("vtt", "text/vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n最新字幕\n"),
        ("txt", "text/plain", "最新字幕\n"),
    ],
)
def test_downloads_utf8_attachment_without_ffmpeg_or_export_files(
    subtitle_client,
    monkeypatch,
    file_format: str,
    content_type: str,
    expected: str,
):
    client, library = subtitle_client
    files_before = set(library.library_path.rglob("*"))
    transcript_before = library.load_transcript(ASSET_ID)

    def reject_tool_lookup(*_args, **_kwargs):
        pytest.fail("独立字幕下载不应该查找或调用 FFmpeg")

    monkeypatch.setattr(subtitle_export, "resolve_tool", reject_tool_lookup)
    monkeypatch.setattr(subtitle_export.subprocess, "run", reject_tool_lookup)
    response = client.get(SUBTITLE_URL, params={"format": file_format})

    assert response.status_code == 200
    assert response.content == expected.encode("utf-8")
    assert response.headers["content-type"] == f"{content_type}; charset=utf-8"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["cache-control"] == "no-store"
    disposition = response.headers["content-disposition"]
    assert disposition.startswith(f'attachment; filename="subtitles.{file_format}"; ')
    assert (
        unquote(disposition.split("filename*=UTF-8''")[1])
        == f"中文课程 🎬.{file_format}"
    )
    assert set(library.library_path.rglob("*")) == files_before
    assert library.load_transcript(ASSET_ID) == transcript_before


def test_download_uses_latest_edits_and_saved_display_offset(subtitle_client):
    client, library = subtitle_client
    first_download = client.get(SUBTITLE_URL, params={"format": "txt"})
    library.save_transcript(
        Transcript(
            asset_id=ASSET_ID,
            segments=[
                TranscriptSegment(
                    start_seconds=0.2, end_seconds=1.5, text="编辑 <原文>"
                ),
                TranscriptSegment(start_seconds=9, end_seconds=12, text="结尾"),
            ],
        )
    )
    settings_response = client.patch(
        f"/api/media/assets/{ASSET_ID}/subtitle-settings",
        json={"offset_milliseconds": 500},
    )
    second_download = client.get(SUBTITLE_URL, params={"format": "srt"})
    plain_download = client.get(SUBTITLE_URL, params={"format": "txt"})

    assert settings_response.status_code == 200
    assert first_download.text == "最新字幕\n"
    assert second_download.text == (
        "1\n00:00:00,000 --> 00:00:01,000\n编辑 &lt;原文&gt;\n\n"
        "2\n00:00:08,500 --> 00:00:10,000\n结尾\n"
    )
    assert plain_download.text == "编辑 <原文>\n\n结尾\n"
    assert library.load_transcript(ASSET_ID).segments[0].start_seconds == 0.2


@pytest.mark.parametrize("file_format", ["ass", "mp4", "SRT", "../srt", ""])
def test_rejects_unknown_file_formats(subtitle_client, file_format: str):
    client, _library = subtitle_client
    assert client.get(SUBTITLE_URL, params={"format": file_format}).status_code == 422


def test_requires_explicit_file_format(subtitle_client):
    client, _library = subtitle_client
    assert client.get(SUBTITLE_URL).status_code == 422


@pytest.mark.parametrize(
    ("asset_status", "media_type", "expected_status"),
    [
        (MediaAssetStatus.PENDING, MediaType.VIDEO, 409),
        (MediaAssetStatus.FAILED, MediaType.VIDEO, 409),
        (MediaAssetStatus.READY, MediaType.IMAGE, 422),
    ],
)
def test_rejects_unready_and_non_video_assets(
    subtitle_client, asset_status, media_type, expected_status: int
):
    client, library = subtitle_client
    asset = library.get(ASSET_ID)
    asset.status = asset_status
    asset.media_type = media_type
    library.save(asset)
    assert (
        client.get(SUBTITLE_URL, params={"format": "srt"}).status_code
        == expected_status
    )


def test_returns_404_for_unknown_or_invalid_asset(subtitle_client):
    client, _library = subtitle_client
    missing_asset_id = str(uuid7())
    for asset_id in [missing_asset_id, "invalid"]:
        response = client.get(
            f"/api/media/assets/{asset_id}/subtitle-file", params={"format": "srt"}
        )
        assert response.status_code == 404


@pytest.mark.parametrize(
    "segments",
    [
        [],
        [TranscriptSegment(start_seconds=1, end_seconds=2, text=" \n ")],
        [TranscriptSegment(start_seconds=12, end_seconds=13, text="视频之外")],
    ],
)
def test_returns_409_without_usable_cues(subtitle_client, segments):
    client, library = subtitle_client
    library.save_transcript(Transcript(asset_id=ASSET_ID, segments=segments))
    assert client.get(SUBTITLE_URL, params={"format": "srt"}).status_code == 409


def test_returns_409_without_transcript(subtitle_client, monkeypatch):
    client, library = subtitle_client
    monkeypatch.setattr(library, "load_transcript", lambda _asset_id: None)
    assert client.get(SUBTITLE_URL, params={"format": "srt"}).status_code == 409


def test_sanitizes_filename_path_separators_controls_and_quotes(subtitle_client):
    client, library = subtitle_client
    asset = library.get(ASSET_ID)
    asset.title = '../../课程\\标题\r\n".mp4'
    library.save(asset)
    response = client.get(SUBTITLE_URL, params={"format": "vtt"})
    disposition = response.headers["content-disposition"]
    file_name = unquote(disposition.split("filename*=UTF-8''")[1])

    assert response.status_code == 200
    assert file_name.endswith(".vtt")
    assert "课程" in file_name
    assert not any(character in file_name for character in '/\\\r\n"')
    assert not file_name.startswith(".")
