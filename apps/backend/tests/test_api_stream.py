from pathlib import Path

from fastapi.testclient import TestClient

from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import (
    MediaAsset,
    MediaAssetStatus,
    SourcePlatform,
    SubtitleDisplaySettings,
)
from openvideo.core.thumbnails import ThumbnailStoryboard
from openvideo.core.transcription_models import Transcript, TranscriptSegment
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
            duration_seconds=20,
            width=1920,
            height=1080,
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


def test_saves_subtitle_settings_in_the_asset_configuration(tmp_path: Path):
    with create_client(tmp_path) as client:
        response = client.patch(
            f"/api/media/assets/{ASSET_ID}/subtitle-settings",
            json={
                "font_size": "large",
                "position": "raised",
                "background": "solid",
                "offset_milliseconds": 150,
            },
        )
        asset_response = client.get(f"/api/media/assets/{ASSET_ID}")
    with TestClient(create_app(Settings(library_path=tmp_path))) as client:
        reopened_asset_response = client.get(f"/api/media/assets/{ASSET_ID}")

    expected_settings = {
        "font_size": "large",
        "position": "raised",
        "background": "solid",
        "offset_milliseconds": 150,
    }
    assert response.status_code == 200
    assert response.json() == expected_settings
    assert asset_response.json()["subtitle_display"] == expected_settings
    assert reopened_asset_response.json()["subtitle_display"] == expected_settings
    configuration_path = tmp_path / "assets" / ASSET_ID / "video-config.json"
    assert configuration_path.is_file()
    assert '"subtitle_display"' in configuration_path.read_text(encoding="utf-8")


def test_generates_a_storyboard_only_when_a_compatibility_browser_requests_it(
    monkeypatch,
    tmp_path: Path,
):
    generation_calls = []

    def generate_storyboard(
        _video_path,
        media_directory,
        duration_seconds,
        source_width,
        source_height,
        _configured_ffmpeg_path,
        _project_bin_dir,
    ):
        generation_calls.append((duration_seconds, source_width, source_height))
        (media_directory / "scrub-storyboard-v2.jpg").write_bytes(b"storyboard")
        return ThumbnailStoryboard(
            sprite_path="scrub-storyboard-v2.jpg",
            tile_width=640,
            tile_height=360,
            interval_seconds=5,
            columns=10,
            total_tiles=5,
        )

    monkeypatch.setattr(media_routes, "generate_thumbnail_sprite", generate_storyboard)

    with create_client(tmp_path) as client:
        first_response = client.post(
            f"/api/media/assets/{ASSET_ID}/thumbnail-storyboard"
        )
        second_response = client.post(
            f"/api/media/assets/{ASSET_ID}/thumbnail-storyboard"
        )

    assert first_response.status_code == 200
    assert first_response.json()["url"] == (
        f"/api/media/assets/{ASSET_ID}/thumbnail-sprite"
    )
    assert first_response.json()["version"] == 2
    assert first_response.json()["tile_width"] == 640
    assert second_response.status_code == 200
    assert generation_calls == [(20, 1920, 1080)]


def test_replaces_a_legacy_storyboard_when_a_compatibility_browser_requests_it(
    monkeypatch,
    tmp_path: Path,
):
    generation_calls = []

    def generate_storyboard(
        _video_path,
        media_directory,
        _duration_seconds,
        _source_width,
        _source_height,
        _configured_ffmpeg_path,
        _project_bin_dir,
    ):
        generation_calls.append(media_directory)
        (media_directory / "scrub-storyboard-v2.jpg").write_bytes(b"current")
        return ThumbnailStoryboard(
            sprite_path="scrub-storyboard-v2.jpg",
            tile_width=640,
            tile_height=360,
            interval_seconds=5,
            columns=10,
            total_tiles=5,
        )

    client = create_client(tmp_path)
    client.close()
    library = MediaLibrary.open(tmp_path)
    asset = library.get(ASSET_ID)
    assert asset is not None
    legacy_directory = library.media_directory(ASSET_ID)
    (legacy_directory / "thumbnails.jpg").write_bytes(b"legacy")
    library.save(
        asset.model_copy(
            update={
                "thumbnail_sprite_path": "media/thumbnails.jpg",
                "thumbnail_tile_width": 640,
                "thumbnail_tile_height": 360,
                "thumbnail_interval_seconds": 5,
                "thumbnail_columns": 10,
                "thumbnail_total_tiles": 5,
            }
        )
    )
    library.close()
    monkeypatch.setattr(media_routes, "generate_thumbnail_sprite", generate_storyboard)

    with TestClient(create_app(Settings(library_path=tmp_path))) as client:
        response = client.post(
            f"/api/media/assets/{ASSET_ID}/thumbnail-storyboard"
        )

    assert response.status_code == 200
    assert response.json()["version"] == 2
    assert len(generation_calls) == 1


def test_exports_video_with_saved_subtitle_settings(monkeypatch, tmp_path: Path):
    exported_settings = []

    def export_video(
        _media_path,
        _segments,
        subtitle_settings,
        output_path,
        _configured_ffmpeg_path,
        _project_bin_dir,
    ) -> None:
        exported_settings.append(subtitle_settings)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"subtitled-video")

    monkeypatch.setattr(media_routes, "export_subtitled_video", export_video)

    library = (
        MediaLibrary.open(tmp_path) if (tmp_path / "library.json").is_file() else None
    )
    if library is None:
        client = create_client(tmp_path)
        client.close()
        library = MediaLibrary.open(tmp_path)
    library.save_transcript(
        Transcript(
            asset_id=ASSET_ID,
            segments=[
                TranscriptSegment(start_seconds=0, end_seconds=2, text="导出字幕")
            ],
        )
    )
    configuration = library.load_video_configuration(ASSET_ID)
    library.save_video_configuration(
        configuration.model_copy(
            update={"subtitle_display": SubtitleDisplaySettings(font_size="large")}
        )
    )
    library.close()

    with TestClient(create_app(Settings(library_path=tmp_path))) as client:
        response = client.post(f"/api/media/assets/{ASSET_ID}/subtitle-exports")

    assert response.status_code == 201
    payload = response.json()
    assert payload["export_id"].startswith("export-")
    assert payload["relative_path"].startswith(
        f"assets/{ASSET_ID}/artifacts/subtitle-exports/subtitled-"
    )
    assert (
        tmp_path / Path(payload["relative_path"])
    ).read_bytes() == b"subtitled-video"
    assert exported_settings[0].font_size == "large"
