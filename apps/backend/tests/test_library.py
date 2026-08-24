import json
import sqlite3
from pathlib import Path

from openvideo.core.analysis_models import Transcript, TranscriptSegment
from openvideo.core.library import MediaLibrary
from openvideo.core.models import MediaAsset, MediaAssetStatus, SourcePlatform


ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"


def test_saves_and_recovers_ready_asset(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    asset_directory = library.asset_directory(ASSET_ID)
    asset_directory.mkdir(parents=True, exist_ok=True)
    (asset_directory / "playback.mp4").write_bytes(b"video")
    asset = MediaAsset(
        asset_id=ASSET_ID,
        source_url="https://www.bilibili.com/video/BV1xx411c7mD",
        source_platform=SourcePlatform.BILIBILI,
        source_video_id="BV1xx411c7mD",
        title="测试视频",
        status=MediaAssetStatus.READY,
        playback_path="playback.mp4",
    )
    library.save(asset)
    metadata = json.loads((asset_directory / "meta.json").read_text(encoding="utf-8"))
    assert metadata["asset_id"] == ASSET_ID
    assert metadata["media_type"] == "video"
    assert metadata["source"]["platform"] == "bilibili"
    assert metadata["video"]["video_codec"] is None

    library.close()
    recovered = MediaLibrary.open(tmp_path)
    loaded_asset = recovered.get(ASSET_ID)
    assert loaded_asset is not None
    assert loaded_asset.title == "测试视频"
    response = recovered.response_for(loaded_asset)
    assert response.playback_url == f"/api/media/assets/{ASSET_ID}/stream"
    assert "playback.mp4" not in response.model_dump_json()
    assert str(tmp_path) not in response.model_dump_json()
    recovered.close()


def test_migrates_legacy_asset_id_and_directory(tmp_path: Path):
    legacy_asset_id = f"asset-{ASSET_ID.replace('-', '')}"
    library = MediaLibrary.initialize_directory(tmp_path)
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="https://www.youtube.com/watch?v=test",
            source_platform=SourcePlatform.YOUTUBE,
        )
    )
    library.close()

    connection = sqlite3.connect(tmp_path / "openvideo.sqlite3")
    connection.execute("ALTER TABLE assets DROP COLUMN media_type")
    connection.execute(
        "UPDATE assets SET asset_id = ? WHERE asset_id = ?", (legacy_asset_id, ASSET_ID)
    )
    connection.execute("PRAGMA user_version = 1")
    connection.commit()
    connection.close()
    (tmp_path / "assets" / ASSET_ID).rename(tmp_path / "assets" / legacy_asset_id)

    migrated = MediaLibrary.open(tmp_path)
    assert migrated.get(ASSET_ID) is not None
    assert not (tmp_path / "assets" / legacy_asset_id).exists()
    metadata = json.loads(
        (tmp_path / "assets" / ASSET_ID / "meta.json").read_text(encoding="utf-8")
    )
    assert metadata["asset_id"] == ASSET_ID
    assert metadata["media_type"] == "video"
    migrated.close()


def test_source_video_id_deduplication_is_scoped_to_platform(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="https://www.bilibili.com/video/BV1xx411c7mD",
            source_platform=SourcePlatform.BILIBILI,
            source_video_id="shared-id",
        )
    )

    assert library.find_by_source_video_id(SourcePlatform.BILIBILI, "shared-id") is not None
    assert library.find_by_source_video_id(SourcePlatform.YOUTUBE, "shared-id") is None
    library.close()


def test_migrates_agent_job_schema_from_database_version_three(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    library.close()
    connection = sqlite3.connect(tmp_path / "openvideo.sqlite3")
    connection.execute("DROP TABLE agent_jobs")
    connection.execute("PRAGMA user_version = 3")
    connection.commit()
    connection.close()

    migrated = MediaLibrary.open(tmp_path)

    assert migrated.load_agent_jobs() == []
    migrated.close()


def test_migrates_transcript_metadata_from_database_version_five(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="https://example.com/video",
            source_platform=SourcePlatform.YOUTUBE,
        )
    )
    library.save_transcript(
        Transcript(
            asset_id=ASSET_ID,
            segments=[TranscriptSegment(start_seconds=0, end_seconds=1, text="旧字幕")],
        )
    )
    library.close()
    connection = sqlite3.connect(tmp_path / "openvideo.sqlite3")
    connection.execute("ALTER TABLE transcript_segments DROP COLUMN audio_events")
    connection.execute("ALTER TABLE transcript_segments DROP COLUMN emotion")
    connection.execute("PRAGMA user_version = 5")
    connection.commit()
    connection.close()

    migrated = MediaLibrary.open(tmp_path)
    transcript = migrated.load_transcript(ASSET_ID)

    assert transcript is not None
    assert transcript.segments[0].emotion is None
    assert transcript.segments[0].audio_events == []
    migrated.close()


def test_marks_interrupted_asset_as_failed(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="https://b23.tv/AbC123",
            source_platform=SourcePlatform.BILIBILI,
            status=MediaAssetStatus.DOWNLOADING,
        )
    )

    library.close()
    recovered = MediaLibrary.open(tmp_path)
    asset = recovered.get(ASSET_ID)
    assert asset is not None
    assert asset.status == MediaAssetStatus.FAILED
    assert asset.error_message
    recovered.close()
