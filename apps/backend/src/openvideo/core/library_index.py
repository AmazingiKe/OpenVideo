"""SQLite 查询投影的 schema、增量同步与安全重建。"""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from openvideo.core.library_files import (
    AssetFileBundle,
    AssetIndexError,
    IndexIssue,
    load_asset_bundle,
)
from openvideo.core.folder_models import Folder, FolderManifest


DATABASE_FILE_NAME = "openvideo.sqlite3"
DATABASE_VERSION = 14
REQUIRED_AGENT_TABLES = {
    "agent_sessions",
    "agent_events",
    "agent_runs",
    "summary_agent_sessions",
    "summary_agent_proposals",
    "marker_agent_sessions",
    "marker_agent_proposals",
}
LEGACY_AGENT_TABLES = {
    "summary_conversations",
    "summary_messages",
    "summary_proposals",
    "summary_agent_runs",
}


def open_index_database(library_path: Path, assets_path: Path) -> sqlite3.Connection:
    database_path = library_path / DATABASE_FILE_NAME
    if not _database_matches_schema(database_path):
        _rebuild_database(database_path, library_path / "temp", assets_path)
    connection = _connect(database_path)
    _ensure_download_quality_schema(connection)
    _ensure_download_event_schema(connection)
    synchronize_folders(connection, library_path / "folders.json")
    synchronize_index(connection, assets_path)
    return connection


def synchronize_folders(connection: sqlite3.Connection, manifest_path: Path) -> None:
    folders = _load_folders(manifest_path)
    folder_ids = {folder.folder_id for folder in folders}
    with connection:
        for folder in sorted(
            folders, key=lambda item: item.materialized_path.count("/")
        ):
            values = folder.model_dump(mode="json")
            columns = tuple(values)
            updates = ", ".join(f"{column}=excluded.{column}" for column in columns[1:])
            connection.execute(
                f"INSERT INTO folders ({', '.join(columns)}) "
                f"VALUES ({', '.join('?' for _ in columns)}) "
                f"ON CONFLICT(folder_id) DO UPDATE SET {updates}",
                tuple(values[column] for column in columns),
            )
        if folder_ids:
            placeholders = ", ".join("?" for _ in folder_ids)
            connection.execute(
                f"DELETE FROM folders WHERE folder_id NOT IN ({placeholders})",
                tuple(sorted(folder_ids)),
            )
        else:
            connection.execute("DELETE FROM folders")


def synchronize_index(connection: sqlite3.Connection, assets_path: Path) -> None:
    indexed_ids = {
        row[0] for row in connection.execute("SELECT asset_id FROM index_states")
    }
    scanned_ids: set[str] = set()
    with connection:
        connection.execute("DELETE FROM index_issues")
        for asset_directory in sorted(
            assets_path.iterdir(), key=lambda path: path.name
        ):
            try:
                bundle = load_asset_bundle(assets_path, asset_directory)
            except AssetIndexError as error:
                if error.issue.asset_id is not None:
                    scanned_ids.add(error.issue.asset_id)
                    remove_asset_projection(connection, error.issue.asset_id)
                _save_issue(connection, error.issue)
                continue
            asset_id = bundle.asset.asset_id
            scanned_ids.add(asset_id)
            row = connection.execute(
                "SELECT content_digest FROM index_states WHERE asset_id = ?",
                (asset_id,),
            ).fetchone()
            if row is None or row[0] != bundle.digest:
                try:
                    replace_asset_projection(connection, bundle)
                except sqlite3.IntegrityError as error:
                    remove_asset_projection(connection, asset_id)
                    _save_issue(
                        connection,
                        IndexIssue(
                            asset_id=asset_id,
                            relative_path=f"assets/{asset_id}",
                            code="index_constraint",
                            message=str(error),
                        ),
                    )
        for asset_id in indexed_ids - scanned_ids:
            remove_asset_projection(connection, asset_id)


def synchronize_asset(
    connection: sqlite3.Connection, assets_path: Path, asset_id: str
) -> None:
    asset_directory = assets_path / asset_id
    try:
        bundle = load_asset_bundle(assets_path, asset_directory)
    except AssetIndexError as error:
        with connection:
            remove_asset_projection(connection, asset_id)
            connection.execute(
                "DELETE FROM index_issues WHERE asset_id = ?", (asset_id,)
            )
            _save_issue(connection, error.issue)
        raise
    try:
        with connection:
            replace_asset_projection(connection, bundle)
            connection.execute(
                "DELETE FROM index_issues WHERE asset_id = ?", (asset_id,)
            )
    except sqlite3.IntegrityError as error:
        issue = IndexIssue(
            asset_id=asset_id,
            relative_path=f"assets/{asset_id}",
            code="index_constraint",
            message=str(error),
        )
        with connection:
            remove_asset_projection(connection, asset_id)
            _save_issue(connection, issue)
        raise AssetIndexError(issue) from error


def replace_asset_projection(
    connection: sqlite3.Connection, bundle: AssetFileBundle
) -> None:
    asset = bundle.asset
    values = asset.model_dump(mode="json")
    columns = tuple(values)
    updates = ", ".join(f"{column}=excluded.{column}" for column in columns[1:])
    connection.execute(
        f"INSERT INTO assets ({', '.join(columns)}) "
        f"VALUES ({', '.join('?' for _ in columns)}) "
        f"ON CONFLICT(asset_id) DO UPDATE SET {updates}",
        tuple(_sqlite_value(values[column]) for column in columns),
    )

    connection.execute(
        "DELETE FROM timeline_segments WHERE asset_id = ?", (asset.asset_id,)
    )
    connection.execute("DELETE FROM markers WHERE asset_id = ?", (asset.asset_id,))
    for marker in bundle.markers:
        connection.execute(
            "INSERT INTO markers(marker_id, asset_id, start_seconds, end_seconds, title, "
            "marker_range_before_seconds, marker_range_after_seconds) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                marker.marker_id,
                marker.asset_id,
                marker.start_seconds,
                marker.end_seconds,
                marker.title,
                marker.marker_range_before_seconds,
                marker.marker_range_after_seconds,
            ),
        )
        _replace_tags(
            connection, "marker_tags", "marker_id", marker.marker_id, marker.tags
        )
    for position, segment in enumerate(bundle.segments):
        connection.execute(
            "INSERT INTO timeline_segments "
            "(segment_id, asset_id, position, start_seconds, end_seconds, title, "
            "detailed_summary, transcript_text, speaker_name, visual_description, ocr_text) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                segment.segment_id,
                segment.asset_id,
                position,
                segment.start_seconds,
                segment.end_seconds,
                segment.title,
                segment.detailed_summary,
                segment.transcript_text,
                segment.speaker_name,
                segment.visual_description,
                segment.ocr_text,
            ),
        )
        connection.executemany(
            "INSERT INTO segment_frames(segment_id, position, relative_path) VALUES (?, ?, ?)",
            [
                (segment.segment_id, frame_position, relative_path)
                for frame_position, relative_path in enumerate(segment.key_frame_paths)
            ],
        )
        _replace_tags(
            connection, "segment_tags", "segment_id", segment.segment_id, segment.tags
        )
        connection.executemany(
            "INSERT INTO segment_markers(segment_id, marker_id) VALUES (?, ?)",
            [
                (segment.segment_id, marker_id)
                for marker_id in dict.fromkeys(segment.marker_ids)
            ],
        )

    document_ids = {document.document_id for document in bundle.summary_documents}
    for document in sorted(
        bundle.summary_documents,
        key=lambda item: (item.parent_document_id is not None, item.position),
    ):
        document_values = document.model_dump(mode="json", exclude={"markdown"})
        document_columns = tuple(document_values)
        document_updates = ", ".join(
            f"{column}=excluded.{column}" for column in document_columns[1:]
        )
        connection.execute(
            f"INSERT INTO summary_documents ({', '.join(document_columns)}) "
            f"VALUES ({', '.join('?' for _ in document_columns)}) "
            f"ON CONFLICT(document_id) DO UPDATE SET {document_updates}",
            tuple(document_values[column] for column in document_columns),
        )
    _delete_missing(
        connection,
        "summary_documents",
        "document_id",
        "asset_id",
        asset.asset_id,
        document_ids,
    )

    for record in bundle.conversations:
        legacy = record.conversation
        session_id = f"session-{legacy.conversation_id.removeprefix('conversation-')}"
        connection.execute(
            "INSERT INTO agent_sessions "
            "(session_id, agent_type, title, created_at, updated_at) "
            "VALUES (?, 'summary', ?, ?, ?) ON CONFLICT(session_id) DO NOTHING",
            (
                session_id,
                legacy.title,
                legacy.created_at.isoformat(),
                legacy.updated_at.isoformat(),
            ),
        )
        connection.execute(
            "INSERT INTO summary_agent_sessions(session_id, asset_id, root_document_id) "
            "VALUES (?, ?, ?) ON CONFLICT(session_id) DO NOTHING",
            (session_id, legacy.asset_id, legacy.root_document_id),
        )
        for sequence, message in enumerate(record.messages, start=1):
            event_id = f"event-{message.message_id.removeprefix('message-')}"
            payload = json.dumps(
                {
                    "legacy_message_id": message.message_id,
                    "role": message.role.value,
                    "content": message.content,
                    "created_at": message.created_at.isoformat(),
                },
                ensure_ascii=False,
            )
            connection.execute(
                "INSERT OR IGNORE INTO agent_events "
                "(event_id, session_id, sequence, run_id, event_type, payload, created_at) "
                "VALUES (?, ?, ?, NULL, 'archive/message', ?, ?)",
                (
                    event_id,
                    session_id,
                    sequence,
                    payload,
                    message.created_at.isoformat(),
                ),
            )
        for proposal in record.proposals:
            proposal_values = {
                key: _sqlite_value(value)
                for key, value in proposal.model_dump(mode="json").items()
            }
            columns = tuple(proposal_values)
            connection.execute(
                f"INSERT OR IGNORE INTO summary_agent_proposals "
                f"({', '.join(columns)}) VALUES "
                f"({', '.join('?' for _ in columns)})",
                tuple(proposal_values[column] for column in columns),
            )

    connection.execute(
        "DELETE FROM summary_media WHERE asset_id = ?", (asset.asset_id,)
    )
    for media in bundle.summary_media:
        _insert_model(connection, "summary_media", media.model_dump(mode="json"))
    connection.execute(
        "INSERT INTO index_states(asset_id, content_digest, indexed_at) VALUES (?, ?, ?) "
        "ON CONFLICT(asset_id) DO UPDATE SET "
        "content_digest=excluded.content_digest, indexed_at=excluded.indexed_at",
        (asset.asset_id, bundle.digest, datetime.now(UTC).isoformat()),
    )


def remove_asset_projection(connection: sqlite3.Connection, asset_id: str) -> None:
    connection.execute("DELETE FROM assets WHERE asset_id = ?", (asset_id,))
    connection.execute("DELETE FROM index_states WHERE asset_id = ?", (asset_id,))


def load_index_issues(connection: sqlite3.Connection) -> list[IndexIssue]:
    rows = connection.execute(
        "SELECT asset_id, relative_path, code, message FROM index_issues "
        "ORDER BY relative_path, code"
    ).fetchall()
    return [IndexIssue.model_validate(dict(row)) for row in rows]


def _database_matches_schema(database_path: Path) -> bool:
    if not database_path.is_file() or database_path.is_symlink():
        return False
    try:
        connection = sqlite3.connect(database_path)
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        healthy = connection.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        proposal_columns = {
            row[1]
            for row in connection.execute("PRAGMA table_info(summary_agent_proposals)")
        }
        asset_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(assets)")
        }
        connection.close()
    except sqlite3.Error:
        return False
    return (
        version == DATABASE_VERSION
        and healthy
        and REQUIRED_AGENT_TABLES <= tables
        and not LEGACY_AGENT_TABLES & tables
        and "session_id" in proposal_columns
        and "folders" in tables
        and "folder_id" in asset_columns
    )


def _rebuild_database(
    database_path: Path, temporary_root: Path, assets_path: Path
) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".openvideo-index-", suffix=".sqlite3", dir=temporary_root
    )
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    try:
        connection = sqlite3.connect(temporary_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.executescript(_SCHEMA)
        connection.execute(f"PRAGMA user_version = {DATABASE_VERSION}")
        synchronize_folders(connection, database_path.parent / "folders.json")
        synchronize_index(connection, assets_path)
        connection.commit()
        connection.close()
        os.replace(temporary_path, database_path)
        for suffix in ("-wal", "-shm"):
            Path(f"{database_path}{suffix}").unlink(missing_ok=True)
    finally:
        temporary_path.unlink(missing_ok=True)


def _connect(database_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(database_path, timeout=5, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA busy_timeout = 5000")
    connection.execute("PRAGMA synchronous = NORMAL")
    return connection


def _ensure_download_event_schema(connection: sqlite3.Connection) -> None:
    """事件日志独立增量建表，避免升级查询投影时删除已有任务历史。"""

    with connection:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS download_events ("
            "event_id TEXT PRIMARY KEY, "
            "job_id TEXT NOT NULL REFERENCES download_jobs(job_id) ON DELETE CASCADE, "
            "stage TEXT NOT NULL, progress_percent REAL NOT NULL, "
            "message TEXT NOT NULL, error_message TEXT, created_at TEXT NOT NULL)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS download_events_job_created_index "
            "ON download_events(job_id, created_at)"
        )


def _ensure_download_quality_schema(connection: sqlite3.Connection) -> None:
    """旧资料库增量补齐画质字段，避免为运行时任务表重建整个查询投影。"""

    columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(download_jobs)")
    }
    if "video_quality" in columns:
        return
    with connection:
        connection.execute(
            "ALTER TABLE download_jobs ADD COLUMN "
            "video_quality TEXT NOT NULL DEFAULT 'best'"
        )


def _save_issue(connection: sqlite3.Connection, issue: IndexIssue) -> None:
    issue_key = f"{issue.asset_id or ''}\0{issue.relative_path}\0{issue.code}"
    connection.execute(
        "INSERT OR REPLACE INTO index_issues "
        "(issue_key, asset_id, relative_path, code, message) VALUES (?, ?, ?, ?, ?)",
        (
            issue_key,
            issue.asset_id,
            issue.relative_path,
            issue.code,
            issue.message,
        ),
    )


def _replace_tags(
    connection: sqlite3.Connection,
    table_name: str,
    identifier_column: str,
    identifier: str,
    tags: list[str],
) -> None:
    for tag in dict.fromkeys(tags):
        connection.execute("INSERT OR IGNORE INTO tags(name) VALUES (?)", (tag,))
        connection.execute(
            f"INSERT INTO {table_name}({identifier_column}, tag_name) VALUES (?, ?)",
            (identifier, tag),
        )


def _delete_missing(
    connection: sqlite3.Connection,
    table_name: str,
    identifier_column: str,
    owner_column: str,
    owner_id: str,
    identifiers: set[str],
) -> None:
    if identifiers:
        placeholders = ", ".join("?" for _ in identifiers)
        connection.execute(
            f"DELETE FROM {table_name} WHERE {owner_column} = ? "
            f"AND {identifier_column} NOT IN ({placeholders})",
            (owner_id, *sorted(identifiers)),
        )
    else:
        connection.execute(
            f"DELETE FROM {table_name} WHERE {owner_column} = ?", (owner_id,)
        )


def _insert_model(
    connection: sqlite3.Connection, table_name: str, values: dict[str, object]
) -> None:
    columns = tuple(values)
    connection.execute(
        f"INSERT INTO {table_name} ({', '.join(columns)}) "
        f"VALUES ({', '.join('?' for _ in columns)})",
        tuple(values[column] for column in columns),
    )


def _sqlite_value(value: object) -> object:
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return value


def _load_folders(manifest_path: Path) -> list[Folder]:
    if not manifest_path.is_file():
        return []
    manifest = FolderManifest.model_validate_json(
        manifest_path.read_text(encoding="utf-8")
    )
    return manifest.folders


_SCHEMA = """
CREATE TABLE folders (
    folder_id TEXT PRIMARY KEY, name TEXT NOT NULL,
    parent_id TEXT REFERENCES folders(folder_id) ON DELETE CASCADE,
    materialized_path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(parent_id, name COLLATE NOCASE)
);
CREATE TABLE assets (
    asset_id TEXT PRIMARY KEY, folder_id TEXT REFERENCES folders(folder_id) ON DELETE SET NULL,
    media_type TEXT NOT NULL, source_url TEXT NOT NULL,
    source_platform TEXT NOT NULL, source_video_id TEXT, title TEXT NOT NULL,
    author_name TEXT, description TEXT, duration_seconds REAL, width INTEGER,
    height INTEGER, video_codec TEXT, audio_codec TEXT, playback_path TEXT,
    thumbnail_path TEXT, remote_thumbnail_url TEXT, thumbnail_sprite_path TEXT,
    thumbnail_tile_width INTEGER, thumbnail_tile_height INTEGER,
    thumbnail_interval_seconds REAL, thumbnail_columns INTEGER,
    thumbnail_total_tiles INTEGER, status TEXT NOT NULL, error_message TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(source_platform, source_video_id)
);
CREATE TABLE download_jobs (
    job_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    video_quality TEXT NOT NULL, stage TEXT NOT NULL,
    progress_percent REAL NOT NULL, message TEXT NOT NULL,
    error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE download_events (
    event_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES download_jobs(job_id) ON DELETE CASCADE,
    stage TEXT NOT NULL, progress_percent REAL NOT NULL, message TEXT NOT NULL,
    error_message TEXT, created_at TEXT NOT NULL
);
CREATE TABLE analysis_jobs (
    job_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    operation TEXT NOT NULL, mode TEXT NOT NULL, ai_model_id TEXT, strategy TEXT NOT NULL,
    stage TEXT NOT NULL, progress_percent REAL NOT NULL, message TEXT NOT NULL,
    error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE agent_jobs (
    job_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    agent_type TEXT NOT NULL, execution_mode TEXT NOT NULL, stage TEXT NOT NULL,
    progress_percent REAL NOT NULL, message TEXT NOT NULL, ai_model_id TEXT NOT NULL,
    segment_indices TEXT, transcript_checksum TEXT NOT NULL, question TEXT,
    error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE timeline_segments (
    segment_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    position INTEGER NOT NULL, start_seconds REAL NOT NULL, end_seconds REAL NOT NULL,
    title TEXT NOT NULL, detailed_summary TEXT, transcript_text TEXT, speaker_name TEXT,
    visual_description TEXT, ocr_text TEXT, UNIQUE(asset_id, position)
);
CREATE TABLE markers (
    marker_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    start_seconds REAL NOT NULL, end_seconds REAL, title TEXT NOT NULL,
    marker_range_before_seconds INTEGER, marker_range_after_seconds INTEGER
);
CREATE TABLE tags (name TEXT PRIMARY KEY);
CREATE TABLE marker_tags (marker_id TEXT NOT NULL REFERENCES markers(marker_id) ON DELETE CASCADE, tag_name TEXT NOT NULL REFERENCES tags(name), PRIMARY KEY(marker_id, tag_name));
CREATE TABLE segment_tags (segment_id TEXT NOT NULL REFERENCES timeline_segments(segment_id) ON DELETE CASCADE, tag_name TEXT NOT NULL REFERENCES tags(name), PRIMARY KEY(segment_id, tag_name));
CREATE TABLE segment_frames (segment_id TEXT NOT NULL REFERENCES timeline_segments(segment_id) ON DELETE CASCADE, position INTEGER NOT NULL, relative_path TEXT NOT NULL, PRIMARY KEY(segment_id, position));
CREATE TABLE segment_markers (segment_id TEXT NOT NULL REFERENCES timeline_segments(segment_id) ON DELETE CASCADE, marker_id TEXT NOT NULL REFERENCES markers(marker_id) ON DELETE CASCADE, PRIMARY KEY(segment_id, marker_id));
CREATE TABLE analysis_job_markers (job_id TEXT NOT NULL REFERENCES analysis_jobs(job_id) ON DELETE CASCADE, marker_id TEXT NOT NULL, PRIMARY KEY(job_id, marker_id));
CREATE TABLE analysis_job_capabilities (job_id TEXT NOT NULL REFERENCES analysis_jobs(job_id) ON DELETE CASCADE, capability TEXT NOT NULL, PRIMARY KEY(job_id, capability));
CREATE TABLE summary_documents (
    document_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    parent_document_id TEXT REFERENCES summary_documents(document_id) ON DELETE CASCADE,
    title TEXT NOT NULL, relative_path TEXT NOT NULL, content_digest TEXT NOT NULL,
    position INTEGER NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE agent_sessions (
    session_id TEXT PRIMARY KEY, agent_type TEXT NOT NULL, title TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE summary_agent_sessions (
    session_id TEXT PRIMARY KEY REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    root_document_id TEXT NOT NULL REFERENCES summary_documents(document_id) ON DELETE CASCADE
);
CREATE TABLE marker_agent_sessions (
    session_id TEXT PRIMARY KEY REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE
);
CREATE TABLE agent_runs (
    run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
    stage TEXT NOT NULL, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE agent_events (
    event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL, run_id TEXT REFERENCES agent_runs(run_id) ON DELETE SET NULL,
    event_type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(session_id, sequence)
);
CREATE TABLE summary_agent_proposals (
    proposal_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES summary_documents(document_id) ON DELETE CASCADE,
    base_revision INTEGER NOT NULL, proposed_markdown TEXT NOT NULL, explanation TEXT NOT NULL,
    diff TEXT NOT NULL, suggested_subdocuments TEXT NOT NULL, media_suggestions TEXT NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE marker_agent_proposals (
    proposal_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    changes TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE summary_media (
    media_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES summary_documents(document_id) ON DELETE CASCADE,
    media_type TEXT NOT NULL, relative_path TEXT NOT NULL, caption TEXT NOT NULL,
    start_seconds REAL NOT NULL, end_seconds REAL, created_at TEXT NOT NULL
);
CREATE TABLE index_states (
    asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
    content_digest TEXT NOT NULL, indexed_at TEXT NOT NULL
);
CREATE TABLE index_issues (
    issue_key TEXT PRIMARY KEY, asset_id TEXT, relative_path TEXT NOT NULL,
    code TEXT NOT NULL, message TEXT NOT NULL
);
CREATE INDEX assets_created_at_index ON assets(created_at DESC);
CREATE INDEX assets_folder_created_index ON assets(folder_id, created_at DESC);
CREATE INDEX assets_title_index ON assets(title COLLATE NOCASE);
CREATE INDEX folders_parent_name_index ON folders(parent_id, name COLLATE NOCASE);
CREATE INDEX folders_materialized_path_index ON folders(materialized_path);
CREATE INDEX markers_asset_time_index ON markers(asset_id, start_seconds);
CREATE INDEX agent_jobs_asset_created_index ON agent_jobs(asset_id, created_at DESC);
CREATE INDEX download_events_job_created_index ON download_events(job_id, created_at);
CREATE UNIQUE INDEX summary_documents_root_asset_index ON summary_documents(asset_id) WHERE parent_document_id IS NULL;
CREATE INDEX summary_documents_parent_position_index ON summary_documents(parent_document_id, position);
CREATE INDEX agent_sessions_updated_index ON agent_sessions(updated_at DESC);
CREATE INDEX agent_runs_session_created_index ON agent_runs(session_id, created_at);
CREATE INDEX agent_events_session_sequence_index ON agent_events(session_id, sequence);
"""
