import json
import shutil
import sqlite3
from pathlib import Path

import pytest

from openvideo.core.library import MediaLibrary
from openvideo.core.models import MediaAsset, MediaAssetStatus, SourcePlatform
from openvideo.core.summary_models import SummaryConversation


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


def test_migrates_single_summary_conversation_to_history_list(tmp_path: Path):
    document_id = "document-01890f4c7a2b7cc298c4dc0c0c07398f"
    conversation_id = "conversation-01890f4c7a2b7cc298c4dc0c0c07398f"
    created_at = "2026-01-01T00:00:00+00:00"
    library = MediaLibrary.initialize_directory(tmp_path)
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="https://example.com/video",
            source_platform=SourcePlatform.YOUTUBE,
        )
    )
    library.close()
    connection = sqlite3.connect(tmp_path / "openvideo.sqlite3")
    connection.execute("PRAGMA foreign_keys = OFF")
    connection.execute("DROP TABLE summary_conversations")
    connection.execute(
        "CREATE TABLE summary_conversations ("
        "conversation_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, "
        "root_document_id TEXT NOT NULL, created_at TEXT NOT NULL, "
        "updated_at TEXT NOT NULL, UNIQUE(asset_id))"
    )
    connection.execute(
        "INSERT INTO summary_documents VALUES (?, ?, NULL, ?, ?, ?, 0, 1, ?, ?)",
        (
            document_id,
            ASSET_ID,
            "旧总结",
            "index.md",
            "digest",
            created_at,
            created_at,
        ),
    )
    connection.execute(
        "INSERT INTO summary_conversations VALUES (?, ?, ?, ?, ?)",
        (conversation_id, ASSET_ID, document_id, created_at, created_at),
    )
    connection.execute("PRAGMA user_version = 8")
    connection.commit()
    connection.close()

    migrated = MediaLibrary.open(tmp_path)
    conversations = migrated.load_summary_conversations(ASSET_ID)

    assert len(conversations) == 1
    assert conversations[0].title == "默认对话"
    migrated.save_summary_conversation(
        SummaryConversation(
            conversation_id="conversation-01890f4c7a2b7cc298c4dc0c0c073990",
            asset_id=ASSET_ID,
            root_document_id=document_id,
            title="新对话",
        )
    )
    assert len(migrated.load_summary_conversations(ASSET_ID)) == 2
    assert migrated._db().execute("PRAGMA user_version").fetchone()[0] == 9
    migrated.close()


def test_migrates_database_transcript_to_json_from_version_five(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="https://example.com/video",
            source_platform=SourcePlatform.YOUTUBE,
        )
    )
    library.close()
    connection = sqlite3.connect(tmp_path / "openvideo.sqlite3")
    connection.execute(
        "CREATE TABLE transcripts ("
        "asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE, "
        "language TEXT, created_at TEXT NOT NULL)"
    )
    connection.execute(
        "CREATE TABLE transcript_segments ("
        "asset_id TEXT NOT NULL REFERENCES transcripts(asset_id) ON DELETE CASCADE, "
        "position INTEGER NOT NULL, start_seconds REAL NOT NULL, "
        "end_seconds REAL NOT NULL, text TEXT NOT NULL, "
        "PRIMARY KEY(asset_id, position))"
    )
    connection.execute(
        "INSERT INTO transcripts VALUES (?, ?, ?)",
        (ASSET_ID, "zh", "2026-01-01T00:00:00+00:00"),
    )
    connection.execute(
        "INSERT INTO transcript_segments VALUES (?, 0, 0, 1, ?)",
        (ASSET_ID, "旧字幕"),
    )
    connection.execute("PRAGMA user_version = 5")
    connection.commit()
    connection.close()

    migrated = MediaLibrary.open(tmp_path)
    transcript = migrated.load_transcript(ASSET_ID)

    assert transcript is not None
    assert transcript.segments[0].emotion is None
    assert transcript.segments[0].audio_events == []
    transcript_path = tmp_path / "assets" / ASSET_ID / "artifacts" / "transcript.json"
    assert transcript_path.is_file()
    assert not migrated._db().execute(
        "SELECT 1 FROM sqlite_master WHERE name = 'transcripts'"
    ).fetchone()
    metadata = json.loads(
        (tmp_path / "assets" / ASSET_ID / "meta.json").read_text(encoding="utf-8")
    )
    assert metadata["transcription"] == {
        "status": "complete",
        "attempt_count": 1,
    }
    migrated.close()


def test_migrates_summary_bodies_and_media_from_database_version_six(
    tmp_path: Path,
    monkeypatch,
):
    document_id = "document-01890f4c7a2b7cc298c4dc0c0c07398f"
    media_id = "media-01890f4c7a2b7cc298c4dc0c0c07398f"
    created_at = "2026-01-01T00:00:00+00:00"
    library = MediaLibrary.initialize_directory(tmp_path)
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="https://example.com/video",
            source_platform=SourcePlatform.YOUTUBE,
        )
    )
    library.close()
    asset_directory = tmp_path / "assets" / ASSET_ID
    old_media_path = asset_directory / "artifacts" / "summaries" / f"{media_id}.jpg"
    old_media_path.parent.mkdir(parents=True)
    old_media_path.write_bytes(b"jpeg-data")

    connection = sqlite3.connect(tmp_path / "openvideo.sqlite3")
    connection.execute("PRAGMA foreign_keys = OFF")
    connection.execute("DROP TABLE summary_documents")
    connection.execute(
        """
        CREATE TABLE summary_documents (
            document_id TEXT PRIMARY KEY,
            asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
            parent_document_id TEXT REFERENCES summary_documents(document_id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            markdown TEXT NOT NULL,
            position INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    connection.execute(
        "INSERT INTO summary_documents VALUES (?, ?, NULL, ?, ?, 0, 3, ?, ?)",
        (document_id, ASSET_ID, "旧总结", "# 旧正文\n", created_at, created_at),
    )
    connection.execute(
        "INSERT INTO summary_media VALUES (?, ?, ?, 'image', ?, ?, 1, NULL, ?)",
        (
            media_id,
            ASSET_ID,
            document_id,
            f"artifacts/summaries/{media_id}.jpg",
            "画面",
            created_at,
        ),
    )
    connection.execute("PRAGMA user_version = 6")
    connection.commit()
    connection.close()

    original_copy = shutil.copy2

    def interrupt_copy(*_args, **_kwargs):
        raise OSError("模拟迁移中断")

    monkeypatch.setattr("openvideo.core.library.shutil.copy2", interrupt_copy)
    with pytest.raises(OSError, match="模拟迁移中断"):
        MediaLibrary.open(tmp_path)
    assert old_media_path.is_file()
    connection = sqlite3.connect(tmp_path / "openvideo.sqlite3")
    interrupted_columns = {
        row[1] for row in connection.execute("PRAGMA table_info(summary_documents)")
    }
    connection.close()
    assert "markdown" in interrupted_columns

    monkeypatch.setattr("openvideo.core.library.shutil.copy2", original_copy)
    migrated = MediaLibrary.open(tmp_path)
    document = migrated.load_summary_document(document_id)
    media = migrated.load_summary_media(ASSET_ID)[0]
    migrated.close()
    connection = sqlite3.connect(tmp_path / "openvideo.sqlite3")
    columns = {
        row[1]
        for row in connection.execute("PRAGMA table_info(summary_documents)")
    }
    connection.close()

    assert document is not None
    assert document.markdown == "# 旧正文\n"
    assert document.revision == 3
    assert document.relative_path == "index.md"
    assert "markdown" not in columns
    assert media.relative_path == f"summary/assets/{media_id}.jpg"
    assert (asset_directory / media.relative_path).read_bytes() == b"jpeg-data"
    assert not old_media_path.exists()
    assert (asset_directory / "summary" / "manifest.json").is_file()
    assert (tmp_path / "openvideo.sqlite3.v6.backup").is_file()


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
