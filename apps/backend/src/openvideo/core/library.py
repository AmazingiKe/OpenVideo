from __future__ import annotations

import json
import os
import shutil
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from uuid import UUID

import portalocker
from pydantic import BaseModel

from openvideo.core.agent_models import AgentJob
from openvideo.core.analysis_models import (
    AnalysisJob,
    Transcript,
    TranscriptSegment,
    TranscriptionMetadata,
    TranscriptionStatus,
)
from openvideo.core.identifiers import is_uuid7, uuid7
from openvideo.core.summary_models import (
    SummaryAgentRun,
    SummaryConversation,
    SummaryDocument,
    SummaryEditProposal,
    SummaryMediaArtifact,
    SummaryMessage,
)
from openvideo.core.summary_files import (
    SUMMARY_ASSETS_DIRECTORY_NAME,
    SUMMARY_DIRECTORY_NAME,
    build_manifest,
    document_relative_path,
    file_digest,
    markdown_digest,
    read_markdown,
)
from openvideo.core.models import (
    AssetMetadata,
    AssetSourceMetadata,
    AssetTranscriptionMetadata,
    DownloadJob,
    DownloadStage,
    MediaAsset,
    MediaAssetResponse,
    MediaAssetStatus,
    MediaMarker,
    MediaSegment,
    MediaType,
    SourcePlatform,
    ThumbnailStoryboardResponse,
    ThumbnailStoryboardTile,
    VideoMetadata,
)
from openvideo.core.thumbnails import ThumbnailStoryboard, build_thumbnail_tiles


FORMAT_VERSION = 1
DATABASE_VERSION = 9
SUMMARY_DATABASE_VERSION = 5
TRANSCRIPT_METADATA_DATABASE_VERSION = 6
SUMMARY_FILES_DATABASE_VERSION = 7
TRANSCRIPT_FILES_DATABASE_VERSION = 8
MANIFEST_FILE_NAME = "library.json"
DATABASE_FILE_NAME = "openvideo.sqlite3"
AGENT_CHECKPOINT_DATABASE_FILE_NAME = "agent_checkpoints.sqlite3"
LOCK_FILE_NAME = ".openvideo.lock"
ASSET_METADATA_FILE_NAME = "meta.json"
TRANSCRIPTION_METADATA_FILE_NAME = "transcription.json"
TRANSCRIPT_FILE_NAME = "transcript.json"
ARTIFACTS_DIRECTORY_NAME = "artifacts"
PLAYBACK_ROUTE_TEMPLATE = "/api/media/assets/{asset_id}/stream"
THUMBNAIL_ROUTE_TEMPLATE = "/api/media/assets/{asset_id}/thumbnail"
SPRITE_ROUTE_TEMPLATE = "/api/media/assets/{asset_id}/thumbnail-sprite"
HEX_IDENTIFIER_LENGTH = 32


class LibraryError(RuntimeError):
    code = "library_error"


class InvalidLibraryError(LibraryError):
    code = "invalid_library"


class LibraryLockedError(LibraryError):
    code = "library_locked"


class LibraryManifest(BaseModel):
    library_id: str
    name: str
    format_version: int = FORMAT_VERSION
    created_at: datetime


class LibraryDescription(LibraryManifest):
    root_path: str


class MediaLibrary:
    """一个打开会话独占一个可整体移动的资料库，并用 SQLite 管理事务型索引。"""

    def __init__(self, root_path: Path, manifest: LibraryManifest) -> None:
        self.library_path = root_path.resolve()
        self.manifest = manifest
        self.assets_path = self.library_path / "assets"
        self._connection: sqlite3.Connection | None = None
        self._file_lock: portalocker.Lock | None = None
        self._lock = RLock()

    @classmethod
    def initialize_directory(cls, root_path: Path) -> MediaLibrary:
        resolved_path = root_path.resolve()
        if not resolved_path.is_dir():
            raise InvalidLibraryError("指定目录不存在")
        if any(resolved_path.iterdir()):
            raise InvalidLibraryError("只能初始化空目录")
        return cls._initialize(resolved_path, resolved_path.name)

    @classmethod
    def _initialize(cls, root_path: Path, name: str) -> MediaLibrary:
        manifest = LibraryManifest(
            library_id=f"library-{uuid7().hex}",
            name=name,
            created_at=datetime.now(UTC),
        )
        for directory_name in ("assets", "cache", "temp"):
            (root_path / directory_name).mkdir()
        (root_path / MANIFEST_FILE_NAME).write_text(
            manifest.model_dump_json(indent=2), encoding="utf-8"
        )
        library = cls(root_path, manifest)
        library._open_session()
        return library

    @classmethod
    def open(cls, root_path: Path) -> MediaLibrary:
        resolved_path = root_path.resolve()
        manifest_path = resolved_path / MANIFEST_FILE_NAME
        try:
            manifest = LibraryManifest.model_validate_json(
                manifest_path.read_text(encoding="utf-8")
            )
        except (OSError, ValueError) as error:
            raise InvalidLibraryError("该目录不是有效的 OpenVideo 资料库") from error
        cls._validate_identifier(manifest.library_id, "library")
        if manifest.format_version != FORMAT_VERSION:
            raise InvalidLibraryError("资料库格式版本不受支持")
        required_paths = [resolved_path / "assets", resolved_path / "cache", resolved_path / "temp"]
        if any(not path.is_dir() for path in required_paths):
            raise InvalidLibraryError("资料库目录结构不完整")
        library = cls(resolved_path, manifest)
        library._open_session()
        return library

    def _open_session(self) -> None:
        lock = portalocker.Lock(
            self.library_path / LOCK_FILE_NAME,
            mode="a",
            timeout=0,
            flags=portalocker.LOCK_EX | portalocker.LOCK_NB,
        )
        try:
            lock.acquire()
        except portalocker.exceptions.LockException as error:
            raise LibraryLockedError("资料库正被另一个 OpenVideo 进程使用") from error
        try:
            connection = sqlite3.connect(
                self.library_path / DATABASE_FILE_NAME,
                timeout=5,
                check_same_thread=False,
            )
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA busy_timeout = 5000")
            connection.execute("PRAGMA synchronous = NORMAL")
            self._connection = connection
            self._file_lock = lock
            self._migrate()
            self._recover_interrupted_downloads()
        except Exception:
            if self._connection is not None:
                self._connection.close()
                self._connection = None
            self._file_lock = None
            lock.release()
            raise

    @property
    def description(self) -> LibraryDescription:
        return LibraryDescription(**self.manifest.model_dump(), root_path=str(self.library_path))

    @property
    def is_open(self) -> bool:
        return self._connection is not None

    def close(self) -> None:
        with self._lock:
            if self._connection:
                self._connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                self._connection.close()
                self._connection = None
            if self._file_lock:
                self._file_lock.release()
                self._file_lock = None
                try:
                    (self.library_path / LOCK_FILE_NAME).unlink()
                except FileNotFoundError:
                    pass

    def _migrate(self) -> None:
        connection = self._db()
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version > DATABASE_VERSION:
            raise InvalidLibraryError("资料库数据库版本高于当前应用")
        if version == 0:
            connection.executescript(_INITIAL_SCHEMA)
            connection.execute(f"PRAGMA user_version = {DATABASE_VERSION}")
            connection.commit()
        elif version == 1:
            self._migrate_asset_storage()
            version = 2
        if version == 2:
            self._migrate_analysis_model()
            version = 3
        if version == 3:
            self._migrate_agent_jobs()
            version = 4
        if version == 4:
            self._migrate_summaries()
            version = SUMMARY_DATABASE_VERSION
        if version == SUMMARY_DATABASE_VERSION:
            self._migrate_transcript_metadata()
            version = TRANSCRIPT_METADATA_DATABASE_VERSION
        if version == TRANSCRIPT_METADATA_DATABASE_VERSION:
            self._migrate_summary_files()
            version = SUMMARY_FILES_DATABASE_VERSION
        if version == SUMMARY_FILES_DATABASE_VERSION:
            self._migrate_transcripts_to_files()
            version = TRANSCRIPT_FILES_DATABASE_VERSION
        if version == TRANSCRIPT_FILES_DATABASE_VERSION:
            self._migrate_summary_conversations()

    def _migrate_analysis_model(self) -> None:
        connection = self._db()
        with connection:
            columns = {
                row[1] for row in connection.execute("PRAGMA table_info(analysis_jobs)")
            }
            if "ai_model_id" not in columns:
                connection.execute("ALTER TABLE analysis_jobs ADD COLUMN ai_model_id TEXT")
            connection.execute("PRAGMA user_version = 3")

    def _migrate_agent_jobs(self) -> None:
        connection = self._db()
        with connection:
            connection.executescript(_AGENT_JOB_SCHEMA)
            connection.execute("PRAGMA user_version = 4")

    def _migrate_summaries(self) -> None:
        connection = self._db()
        default_strategy = json.dumps(
            AnalysisJob(job_id="job-migration", asset_id="migration").strategy.model_dump(
                mode="json"
            ),
            ensure_ascii=False,
        )
        with connection:
            columns = {
                row[1] for row in connection.execute("PRAGMA table_info(analysis_jobs)")
            }
            if "strategy" not in columns:
                connection.execute("ALTER TABLE analysis_jobs ADD COLUMN strategy TEXT")
                connection.execute(
                    "UPDATE analysis_jobs SET strategy = ? WHERE strategy IS NULL",
                    (default_strategy,),
                )
            connection.executescript(_SUMMARY_SCHEMA)
            connection.execute(f"PRAGMA user_version = {SUMMARY_DATABASE_VERSION}")

    def _migrate_transcript_metadata(self) -> None:
        connection = self._db()
        with connection:
            if not self._table_exists("transcript_segments"):
                connection.execute(
                    f"PRAGMA user_version = {TRANSCRIPT_METADATA_DATABASE_VERSION}"
                )
                return
            columns = {
                row[1]
                for row in connection.execute("PRAGMA table_info(transcript_segments)")
            }
            if "emotion" not in columns:
                connection.execute(
                    "ALTER TABLE transcript_segments ADD COLUMN emotion TEXT"
                )
            if "audio_events" not in columns:
                connection.execute(
                    "ALTER TABLE transcript_segments "
                    "ADD COLUMN audio_events TEXT NOT NULL DEFAULT '[]'"
                )
            connection.execute(
                f"PRAGMA user_version = {TRANSCRIPT_METADATA_DATABASE_VERSION}"
            )

    def _migrate_summary_files(self) -> None:
        connection = self._db()
        backup_path = self.library_path / f"{DATABASE_FILE_NAME}.v6.backup"
        if not backup_path.exists():
            temporary_backup = backup_path.with_suffix(".backup.tmp")
            backup_connection = sqlite3.connect(temporary_backup)
            try:
                connection.backup(backup_connection)
            finally:
                backup_connection.close()
            os.replace(temporary_backup, backup_path)

        rows = connection.execute(
            "SELECT * FROM summary_documents ORDER BY asset_id, "
            "parent_document_id IS NOT NULL, position, created_at"
        ).fetchall()
        media_rows = connection.execute(
            "SELECT * FROM summary_media ORDER BY asset_id, created_at"
        ).fetchall()
        documents_by_asset: dict[str, list[SummaryDocument]] = {}
        staged_directories: dict[str, Path] = {}
        migration_root = self.library_path / "temp" / "summary-v7-migration"
        if migration_root.exists():
            shutil.rmtree(migration_root)
        try:
            for row in rows:
                values = dict(row)
                markdown = values.pop("markdown")
                document = SummaryDocument(
                    **values,
                    markdown=markdown,
                    relative_path="",
                    content_digest=markdown_digest(markdown),
                )
                document = document.model_copy(
                    update={"relative_path": document_relative_path(document)}
                )
                documents_by_asset.setdefault(document.asset_id, []).append(document)

            media_by_asset: dict[str, list[SummaryMediaArtifact]] = {}
            migrated_media_paths: dict[str, str] = {}
            for row in media_rows:
                artifact = SummaryMediaArtifact.model_validate(dict(row))
                source_path = self.asset_directory(artifact.asset_id) / artifact.relative_path
                if not source_path.is_file() or source_path.is_symlink():
                    raise InvalidLibraryError(f"总结资源缺失：{artifact.media_id}")
                suffix = source_path.suffix.lower()
                relative_path = (
                    f"{SUMMARY_DIRECTORY_NAME}/{SUMMARY_ASSETS_DIRECTORY_NAME}/"
                    f"{artifact.media_id}{suffix}"
                )
                migrated = artifact.model_copy(update={"relative_path": relative_path})
                media_by_asset.setdefault(artifact.asset_id, []).append(migrated)
                migrated_media_paths[artifact.media_id] = relative_path

            for asset_id, documents in documents_by_asset.items():
                staged_summary = migration_root / asset_id / SUMMARY_DIRECTORY_NAME
                staged_directories[asset_id] = staged_summary
                for document in documents:
                    destination = staged_summary.joinpath(
                        *Path(document.relative_path).parts
                    )
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_text(document.markdown, encoding="utf-8")
                for artifact in media_by_asset.get(asset_id, []):
                    original = next(
                        item
                        for item in media_rows
                        if item["media_id"] == artifact.media_id
                    )
                    source_path = self.asset_directory(asset_id) / original["relative_path"]
                    destination = migration_root / asset_id / artifact.relative_path
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source_path, destination)
                    if file_digest(source_path) != file_digest(destination):
                        raise InvalidLibraryError(f"总结资源迁移校验失败：{artifact.media_id}")
                manifest = build_manifest(
                    asset_id,
                    documents,
                    media_by_asset.get(asset_id, []),
                )
                (staged_summary / "manifest.json").write_text(
                    manifest.model_dump_json(indent=2),
                    encoding="utf-8",
                )

            for asset_id, staged_summary in staged_directories.items():
                target = self.asset_directory(asset_id) / SUMMARY_DIRECTORY_NAME
                if target.exists():
                    if target.is_symlink():
                        raise InvalidLibraryError("总结目录不能是符号链接")
                    shutil.rmtree(target)
                os.replace(staged_summary, target)

            connection.execute("PRAGMA foreign_keys = OFF")
            try:
                with connection:
                    connection.execute(_SUMMARY_DOCUMENTS_V7_TABLE)
                    for documents in documents_by_asset.values():
                        for document in documents:
                            values = document.model_dump(
                                mode="json", exclude={"markdown"}
                            )
                            columns = tuple(values)
                            connection.execute(
                                f"INSERT INTO summary_documents_v7 "
                                f"({', '.join(columns)}) VALUES "
                                f"({', '.join('?' for _ in columns)})",
                                tuple(values[column] for column in columns),
                            )
                    connection.execute("DROP TABLE summary_documents")
                    connection.execute(
                        "ALTER TABLE summary_documents_v7 RENAME TO summary_documents"
                    )
                    for index_statement in _SUMMARY_DOCUMENT_INDEXES:
                        connection.execute(index_statement)
                    for media_id, relative_path in migrated_media_paths.items():
                        connection.execute(
                            "UPDATE summary_media SET relative_path = ? WHERE media_id = ?",
                            (relative_path, media_id),
                        )
                    connection.execute(
                        f"PRAGMA user_version = {SUMMARY_FILES_DATABASE_VERSION}"
                    )
            finally:
                connection.execute("PRAGMA foreign_keys = ON")
        finally:
            if migration_root.exists():
                shutil.rmtree(migration_root)

        for row in media_rows:
            old_path = self.asset_directory(row["asset_id"]) / row["relative_path"]
            old_path.unlink(missing_ok=True)

    def _migrate_transcripts_to_files(self) -> None:
        connection = self._db()
        backup_path = self.library_path / f"{DATABASE_FILE_NAME}.v7.backup"
        if not backup_path.exists():
            temporary_backup = backup_path.with_suffix(".backup.tmp")
            backup_connection = sqlite3.connect(temporary_backup)
            try:
                connection.backup(backup_connection)
            finally:
                backup_connection.close()
            os.replace(temporary_backup, backup_path)
        if not self._table_exists("transcripts"):
            with connection:
                connection.execute(
                    f"PRAGMA user_version = {TRANSCRIPT_FILES_DATABASE_VERSION}"
                )
            return
        rows = connection.execute(
            "SELECT * FROM transcripts ORDER BY asset_id"
        ).fetchall()
        for row in rows:
            segment_rows = connection.execute(
                "SELECT start_seconds, end_seconds, text, emotion, audio_events "
                "FROM transcript_segments WHERE asset_id = ? ORDER BY position",
                (row["asset_id"],),
            ).fetchall()
            transcript = Transcript(
                asset_id=row["asset_id"],
                language=row["language"],
                created_at=row["created_at"],
                segments=[
                    TranscriptSegment.model_validate(
                        {
                            **dict(segment),
                            "audio_events": json.loads(segment["audio_events"] or "[]"),
                        }
                    )
                    for segment in segment_rows
                ],
            )
            self.save_transcript(transcript)

        with connection:
            connection.execute("DROP TABLE transcript_segments")
            connection.execute("DROP TABLE transcripts")
            connection.execute(
                f"PRAGMA user_version = {TRANSCRIPT_FILES_DATABASE_VERSION}"
            )

    def _migrate_summary_conversations(self) -> None:
        connection = self._db()
        connection.commit()
        connection.execute("PRAGMA foreign_keys = OFF")
        try:
            with connection:
                connection.execute(_SUMMARY_CONVERSATIONS_V9_TABLE)
                connection.execute(
                    "INSERT INTO summary_conversations_v9 "
                    "(conversation_id, asset_id, root_document_id, title, "
                    "created_at, updated_at) "
                    "SELECT conversation_id, asset_id, root_document_id, "
                    "'默认对话', created_at, updated_at FROM summary_conversations"
                )
                connection.execute("DROP TABLE summary_conversations")
                connection.execute(
                    "ALTER TABLE summary_conversations_v9 "
                    "RENAME TO summary_conversations"
                )
                connection.execute(_SUMMARY_CONVERSATIONS_ASSET_UPDATED_INDEX)
                connection.execute(f"PRAGMA user_version = {DATABASE_VERSION}")
        finally:
            connection.execute("PRAGMA foreign_keys = ON")
        if connection.execute("PRAGMA foreign_key_check").fetchone():
            raise InvalidLibraryError("总结会话迁移后关联数据校验失败")

    def _migrate_asset_storage(self) -> None:
        connection = self._db()
        legacy_asset_ids = [
            row[0]
            for row in connection.execute("SELECT asset_id FROM assets")
            if _legacy_asset_uuid(row[0]) is not None
        ]
        moved_directories: list[tuple[Path, Path]] = []
        for legacy_asset_id in legacy_asset_ids:
            asset_id = _legacy_asset_uuid(legacy_asset_id)
            if asset_id is None:
                continue
            legacy_directory = (self.assets_path / legacy_asset_id).resolve()
            asset_directory = (self.assets_path / asset_id).resolve()
            if asset_directory.exists():
                raise InvalidLibraryError(f"资产目录迁移目标已存在：{asset_id}")
            if legacy_directory.exists():
                legacy_directory.rename(asset_directory)
                moved_directories.append((legacy_directory, asset_directory))

        connection.commit()
        connection.execute("PRAGMA foreign_keys = OFF")
        try:
            connection.execute("BEGIN")
            connection.execute(
                "ALTER TABLE assets ADD COLUMN media_type TEXT NOT NULL DEFAULT 'video'"
            )
            for legacy_asset_id in legacy_asset_ids:
                asset_id = _legacy_asset_uuid(legacy_asset_id)
                if asset_id is None:
                    continue
                for table_name, column_name in _ASSET_REFERENCE_COLUMNS:
                    if not self._table_exists(table_name):
                        continue
                    connection.execute(
                        f"UPDATE {table_name} SET {column_name} = ? WHERE {column_name} = ?",
                        (asset_id, legacy_asset_id),
                    )
            connection.execute("PRAGMA user_version = 2")
            connection.commit()
        except Exception:
            connection.rollback()
            for legacy_directory, asset_directory in reversed(moved_directories):
                asset_directory.rename(legacy_directory)
            raise
        finally:
            connection.execute("PRAGMA foreign_keys = ON")

        if connection.execute("PRAGMA foreign_key_check").fetchone():
            raise InvalidLibraryError("资产标识迁移后关联数据校验失败")
        for legacy_directory, asset_directory in moved_directories:
            self._rewrite_transcription_asset_id(
                asset_directory, legacy_directory.name, asset_directory.name
            )
        for asset in self.list():
            self._write_asset_metadata(asset)

    @staticmethod
    def _rewrite_transcription_asset_id(
        asset_directory: Path, legacy_asset_id: str, asset_id: str
    ) -> None:
        metadata_path = (
            asset_directory / ARTIFACTS_DIRECTORY_NAME / TRANSCRIPTION_METADATA_FILE_NAME
        )
        if not metadata_path.is_file():
            return
        try:
            metadata = TranscriptionMetadata.model_validate_json(
                metadata_path.read_text(encoding="utf-8")
            )
        except (OSError, ValueError):
            return
        if metadata.asset_id != legacy_asset_id:
            return
        temporary_path = metadata_path.with_suffix(".tmp")
        temporary_path.write_text(
            metadata.model_copy(update={"asset_id": asset_id}).model_dump_json(indent=2),
            encoding="utf-8",
        )
        os.replace(temporary_path, metadata_path)

    def _recover_interrupted_downloads(self) -> None:
        now = datetime.now(UTC).isoformat()
        terminal_stages = (DownloadStage.COMPLETE.value, DownloadStage.FAILED.value)
        with self._db():
            self._db().execute(
                "UPDATE download_jobs SET stage = ?, message = ?, error_message = ?, updated_at = ? "
                "WHERE stage NOT IN (?, ?)",
                (DownloadStage.FAILED.value, "下载失败", "应用重启中断了下载任务", now, *terminal_stages),
            )
            self._db().execute(
                "UPDATE assets SET status = ?, error_message = ?, updated_at = ? "
                "WHERE status IN (?, ?, ?)",
                (
                    MediaAssetStatus.FAILED.value,
                    "应用重启中断了下载任务",
                    now,
                    MediaAssetStatus.PENDING.value,
                    MediaAssetStatus.DOWNLOADING.value,
                    MediaAssetStatus.PROCESSING.value,
                ),
            )

    def save(self, asset: MediaAsset) -> None:
        self._validate_asset_id(asset.asset_id)
        asset.updated_at = datetime.now(UTC)
        values = asset.model_dump(mode="json")
        columns = tuple(values)
        updates = ", ".join(f"{column}=excluded.{column}" for column in columns[1:])
        placeholders = ", ".join("?" for _ in columns)
        with self._lock, self._db():
            self._db().execute(
                f"INSERT INTO assets ({', '.join(columns)}) VALUES ({placeholders}) "
                f"ON CONFLICT(asset_id) DO UPDATE SET {updates}",
                tuple(_sqlite_value(values[column]) for column in columns),
            )
        self._write_asset_metadata(asset)

    def get(self, asset_id: str) -> MediaAsset | None:
        self._validate_asset_id(asset_id)
        row = self._db().execute("SELECT * FROM assets WHERE asset_id = ?", (asset_id,)).fetchone()
        return MediaAsset.model_validate(dict(row)) if row else None

    def list(self) -> list[MediaAsset]:
        rows = self._db().execute("SELECT * FROM assets ORDER BY created_at DESC").fetchall()
        return [MediaAsset.model_validate(dict(row)) for row in rows]

    def find_by_source_video_id(self, platform: SourcePlatform, source_video_id: str) -> MediaAsset | None:
        row = self._db().execute(
            "SELECT * FROM assets WHERE source_platform = ? AND source_video_id = ? COLLATE NOCASE",
            (platform.value, source_video_id),
        ).fetchone()
        return MediaAsset.model_validate(dict(row)) if row else None

    def save_download_job(self, job: DownloadJob) -> None:
        values = job.model_dump(mode="json")
        columns = tuple(values)
        updates = ", ".join(f"{column}=excluded.{column}" for column in columns[1:])
        with self._lock, self._db():
            self._db().execute(
                f"INSERT INTO download_jobs ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)}) "
                f"ON CONFLICT(job_id) DO UPDATE SET {updates}",
                tuple(_sqlite_value(values[column]) for column in columns),
            )

    def get_download_job(self, job_id: str) -> DownloadJob | None:
        row = self._db().execute("SELECT * FROM download_jobs WHERE job_id = ?", (job_id,)).fetchone()
        return DownloadJob.model_validate(dict(row)) if row else None

    def list_download_jobs(self) -> list[DownloadJob]:
        rows = self._db().execute("SELECT * FROM download_jobs ORDER BY created_at DESC").fetchall()
        return [DownloadJob.model_validate(dict(row)) for row in rows]

    def asset_directory(self, asset_id: str) -> Path:
        self._validate_asset_id(asset_id)
        directory = (self.assets_path / asset_id).resolve()
        if not directory.is_relative_to(self.assets_path):
            raise ValueError("资源目录越出资料库")
        return directory

    def _write_asset_metadata(self, asset: MediaAsset) -> None:
        video_metadata = None
        if asset.media_type == MediaType.VIDEO:
            video_metadata = VideoMetadata(
                duration_seconds=asset.duration_seconds,
                width=asset.width,
                height=asset.height,
                video_codec=asset.video_codec,
                audio_codec=asset.audio_codec,
            )
        transcription_metadata = self.load_transcription_metadata(asset.asset_id)
        if transcription_metadata is not None:
            transcription = AssetTranscriptionMetadata(
                status=transcription_metadata.status,
                attempt_count=transcription_metadata.attempt_count,
            )
        elif self._transcript_path(asset.asset_id).is_file():
            transcription = AssetTranscriptionMetadata(
                status=TranscriptionStatus.COMPLETE,
                attempt_count=1,
            )
        else:
            transcription = AssetTranscriptionMetadata()
        metadata = AssetMetadata(
            asset_id=asset.asset_id,
            media_type=asset.media_type,
            title=asset.title,
            source=AssetSourceMetadata(
                url=asset.source_url,
                platform=asset.source_platform,
                source_id=asset.source_video_id,
                author_name=asset.author_name,
                description=asset.description,
            ),
            video=video_metadata,
            transcription=transcription,
            created_at=asset.created_at,
            updated_at=asset.updated_at,
        )
        asset_directory = self.asset_directory(asset.asset_id)
        asset_directory.mkdir(parents=True, exist_ok=True)
        metadata_path = asset_directory / ASSET_METADATA_FILE_NAME
        temporary_path = metadata_path.with_suffix(".tmp")
        temporary_path.write_text(metadata.model_dump_json(indent=2), encoding="utf-8")
        os.replace(temporary_path, metadata_path)

    def media_directory(self, asset_id: str) -> Path:
        directory = self.asset_directory(asset_id) / "media"
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def artifacts_directory(self, asset_id: str) -> Path:
        directory = self.asset_directory(asset_id) / ARTIFACTS_DIRECTORY_NAME
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def temporary_directory(self, job_id: str) -> Path:
        self._validate_identifier(job_id, "job")
        temp_root = (self.library_path / "temp").resolve()
        directory = (temp_root / job_id).resolve()
        if not directory.is_relative_to(temp_root):
            raise ValueError("临时目录越出资料库")
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def resolve_asset_file(self, asset: MediaAsset, relative_path: str | None) -> Path | None:
        if not relative_path:
            return None
        asset_directory = self.asset_directory(asset.asset_id)
        candidate = (asset_directory / relative_path).resolve()
        if not candidate.is_relative_to(asset_directory) or not candidate.is_file() or candidate.is_symlink():
            return None
        return candidate

    def response_for(self, asset: MediaAsset) -> MediaAssetResponse:
        playback_file = self.resolve_asset_file(asset, asset.playback_path)
        thumbnail_file = self.resolve_asset_file(asset, asset.thumbnail_path)
        return MediaAssetResponse(
            **asset.model_dump(exclude={
                "playback_path", "thumbnail_path", "remote_thumbnail_url", "thumbnail_sprite_path",
                "thumbnail_tile_width", "thumbnail_tile_height", "thumbnail_interval_seconds",
                "thumbnail_columns", "thumbnail_total_tiles",
            }),
            playback_url=PLAYBACK_ROUTE_TEMPLATE.format(asset_id=asset.asset_id) if playback_file else None,
            thumbnail_url=THUMBNAIL_ROUTE_TEMPLATE.format(asset_id=asset.asset_id) if thumbnail_file else None,
            thumbnail_storyboard=self._storyboard_for(asset),
        )

    def _storyboard_for(self, asset: MediaAsset) -> ThumbnailStoryboardResponse | None:
        if not self.resolve_asset_file(asset, asset.thumbnail_sprite_path):
            return None
        values = (
            asset.thumbnail_tile_width, asset.thumbnail_tile_height, asset.thumbnail_interval_seconds,
            asset.thumbnail_columns, asset.thumbnail_total_tiles,
        )
        if any(value is None for value in values):
            return None
        storyboard = ThumbnailStoryboard(
            sprite_path=asset.thumbnail_sprite_path,
            tile_width=asset.thumbnail_tile_width,
            tile_height=asset.thumbnail_tile_height,
            interval_seconds=asset.thumbnail_interval_seconds,
            columns=asset.thumbnail_columns,
            total_tiles=asset.thumbnail_total_tiles,
        )
        tiles = [ThumbnailStoryboardTile(start_time=item.start_time, x=item.x, y=item.y) for item in build_thumbnail_tiles(storyboard)]
        return ThumbnailStoryboardResponse(
            url=SPRITE_ROUTE_TEMPLATE.format(asset_id=asset.asset_id),
            tile_width=storyboard.tile_width,
            tile_height=storyboard.tile_height,
            tiles=tiles,
        )

    def save_transcript(self, transcript: Transcript) -> None:
        self._validate_asset_id(transcript.asset_id)
        asset = self.get(transcript.asset_id)
        if asset is None:
            raise ValueError("转录对应的资源不存在")
        output_path = self._transcript_path(transcript.asset_id)
        temporary_path = output_path.with_suffix(".tmp")
        with self._lock:
            temporary_path.write_text(
                transcript.model_dump_json(indent=2),
                encoding="utf-8",
            )
            os.replace(temporary_path, output_path)
            self._write_asset_metadata(asset)

    def save_transcription_metadata(self, metadata: TranscriptionMetadata) -> None:
        """转写来源需要脱离任务进程保存，便于失败诊断与结果追溯。"""
        output_path = (
            self.artifacts_directory(metadata.asset_id)
            / TRANSCRIPTION_METADATA_FILE_NAME
        )
        temporary_path = output_path.with_suffix(".tmp")
        with self._lock:
            temporary_path.write_text(
                metadata.model_dump_json(indent=2),
                encoding="utf-8",
            )
            os.replace(temporary_path, output_path)
            asset = self.get(metadata.asset_id)
            if asset is not None:
                self._write_asset_metadata(asset)

    def load_transcription_metadata(self, asset_id: str) -> TranscriptionMetadata | None:
        input_path = self.artifacts_directory(asset_id) / TRANSCRIPTION_METADATA_FILE_NAME
        if not input_path.is_file():
            return None
        try:
            raw_metadata = input_path.read_text(encoding="utf-8")
            return TranscriptionMetadata.model_validate_json(raw_metadata)
        except (OSError, ValueError):
            return None

    def load_transcript(self, asset_id: str) -> Transcript | None:
        input_path = self._transcript_path(asset_id)
        if not input_path.is_file():
            return None
        try:
            transcript = Transcript.model_validate_json(
                input_path.read_text(encoding="utf-8")
            )
        except (OSError, ValueError):
            return None
        return transcript if transcript.asset_id == asset_id else None

    def _transcript_path(self, asset_id: str) -> Path:
        return self.artifacts_directory(asset_id) / TRANSCRIPT_FILE_NAME

    def save_segments(self, asset_id: str, segments: list[MediaSegment]) -> None:
        if any(segment.asset_id != asset_id for segment in segments):
            raise ValueError("时间轴事件不属于同一个媒体资源")
        with self._lock, self._db():
            self._db().execute("DELETE FROM timeline_segments WHERE asset_id = ?", (asset_id,))
            for position, segment in enumerate(segments):
                self._db().execute(
                    "INSERT INTO timeline_segments(segment_id, asset_id, position, start_seconds, end_seconds, title, detailed_summary, transcript_text, speaker_name, visual_description, ocr_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (segment.segment_id, asset_id, position, segment.start_seconds, segment.end_seconds, segment.title, segment.detailed_summary, segment.transcript_text, segment.speaker_name, segment.visual_description, segment.ocr_text),
                )
                self._save_segment_relations(segment)

    def _save_segment_relations(self, segment: MediaSegment) -> None:
        self._db().executemany("INSERT INTO segment_frames(segment_id, position, relative_path) VALUES (?, ?, ?)", [(segment.segment_id, index, path) for index, path in enumerate(segment.key_frame_paths)])
        for tag in dict.fromkeys(segment.tags):
            self._db().execute("INSERT OR IGNORE INTO tags(name) VALUES (?)", (tag,))
            self._db().execute("INSERT INTO segment_tags(segment_id, tag_name) VALUES (?, ?)", (segment.segment_id, tag))
        self._db().executemany("INSERT INTO segment_markers(segment_id, marker_id) VALUES (?, ?)", [(segment.segment_id, marker_id) for marker_id in dict.fromkeys(segment.marker_ids)])

    def load_segments(self, asset_id: str) -> list[MediaSegment]:
        rows = self._db().execute("SELECT * FROM timeline_segments WHERE asset_id = ? ORDER BY position", (asset_id,)).fetchall()
        segments: list[MediaSegment] = []
        for row in rows:
            segment_id = row["segment_id"]
            frames = self._db().execute("SELECT relative_path FROM segment_frames WHERE segment_id = ? ORDER BY position", (segment_id,)).fetchall()
            tags = self._db().execute("SELECT tag_name FROM segment_tags WHERE segment_id = ? ORDER BY tag_name", (segment_id,)).fetchall()
            markers = self._db().execute("SELECT marker_id FROM segment_markers WHERE segment_id = ? ORDER BY marker_id", (segment_id,)).fetchall()
            values = dict(row)
            values.pop("position")
            values.update(key_frame_paths=[item[0] for item in frames], tags=[item[0] for item in tags], marker_ids=[item[0] for item in markers])
            segments.append(MediaSegment.model_validate(values))
        return segments

    def save_analysis_job(self, job: AnalysisJob) -> None:
        values = job.model_dump(mode="json", exclude={"marker_ids", "capabilities"})
        columns = tuple(values)
        with self._lock, self._db():
            self._db().execute(
                f"INSERT INTO analysis_jobs ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)}) ON CONFLICT(job_id) DO UPDATE SET " + ", ".join(f"{column}=excluded.{column}" for column in columns[1:]),
                tuple(_sqlite_value(values[column]) for column in columns),
            )
            self._db().execute("DELETE FROM analysis_job_markers WHERE job_id = ?", (job.job_id,))
            self._db().execute("DELETE FROM analysis_job_capabilities WHERE job_id = ?", (job.job_id,))
            self._db().executemany("INSERT INTO analysis_job_markers(job_id, marker_id) VALUES (?, ?)", [(job.job_id, item) for item in dict.fromkeys(job.marker_ids)])
            self._db().executemany("INSERT INTO analysis_job_capabilities(job_id, capability) VALUES (?, ?)", [(job.job_id, item.value) for item in dict.fromkeys(job.capabilities)])

    @property
    def agent_checkpoint_database_path(self) -> Path:
        return self.library_path / AGENT_CHECKPOINT_DATABASE_FILE_NAME

    def save_agent_job(self, job: AgentJob) -> None:
        self._validate_identifier(job.job_id, "agent")
        values = job.model_dump(mode="json")
        columns = tuple(values)
        updates = ", ".join(
            f"{column}=excluded.{column}" for column in columns[1:]
        )
        with self._lock, self._db():
            self._db().execute(
                f"INSERT INTO agent_jobs ({', '.join(columns)}) "
                f"VALUES ({', '.join('?' for _ in columns)}) "
                f"ON CONFLICT(job_id) DO UPDATE SET {updates}",
                tuple(_sqlite_value(values[column]) for column in columns),
            )

    def load_agent_job(self, job_id: str) -> AgentJob | None:
        self._validate_identifier(job_id, "agent")
        row = self._db().execute(
            "SELECT * FROM agent_jobs WHERE job_id = ?",
            (job_id,),
        ).fetchone()
        return _agent_job_from_row(row) if row else None

    def load_agent_jobs(self, asset_id: str | None = None) -> list[AgentJob]:
        if asset_id is None:
            rows = self._db().execute(
                "SELECT * FROM agent_jobs ORDER BY created_at DESC"
            ).fetchall()
        else:
            self._validate_asset_id(asset_id)
            rows = self._db().execute(
                "SELECT * FROM agent_jobs WHERE asset_id = ? ORDER BY created_at DESC",
                (asset_id,),
            ).fetchall()
        return [_agent_job_from_row(row) for row in rows]

    def load_analysis_jobs(self) -> list[AnalysisJob]:
        rows = self._db().execute("SELECT * FROM analysis_jobs ORDER BY created_at").fetchall()
        jobs = []
        for row in rows:
            job_id = row["job_id"]
            values = dict(row)
            if values.get("strategy"):
                values["strategy"] = json.loads(values["strategy"])
            values["marker_ids"] = [item[0] for item in self._db().execute("SELECT marker_id FROM analysis_job_markers WHERE job_id = ? ORDER BY marker_id", (job_id,))]
            values["capabilities"] = [item[0] for item in self._db().execute("SELECT capability FROM analysis_job_capabilities WHERE job_id = ? ORDER BY capability", (job_id,))]
            jobs.append(AnalysisJob.model_validate(values))
        return jobs

    def load_markers(self, asset_id: str) -> list[MediaMarker]:
        rows = self._db().execute("SELECT marker_id, asset_id, time_seconds FROM markers WHERE asset_id = ? ORDER BY time_seconds", (asset_id,)).fetchall()
        return [MediaMarker(**dict(row), tags=[item[0] for item in self._db().execute("SELECT tag_name FROM marker_tags WHERE marker_id = ? ORDER BY tag_name", (row["marker_id"],))]) for row in rows]

    def create_marker(self, marker: MediaMarker) -> MediaMarker:
        self._validate_identifier(marker.marker_id, "marker")
        with self._lock, self._db():
            self._db().execute("INSERT INTO markers(marker_id, asset_id, time_seconds) VALUES (?, ?, ?)", (marker.marker_id, marker.asset_id, marker.time_seconds))
            self._replace_marker_tags(marker.marker_id, marker.tags)
        return marker.model_copy(deep=True)

    def update_marker_tags(self, asset_id: str, marker_id: str, tags: list[str]) -> MediaMarker | None:
        self._validate_identifier(marker_id, "marker")
        row = self._db().execute("SELECT marker_id, asset_id, time_seconds FROM markers WHERE marker_id = ? AND asset_id = ?", (marker_id, asset_id)).fetchone()
        if not row:
            return None
        with self._lock, self._db():
            self._replace_marker_tags(marker_id, tags)
        return MediaMarker(**dict(row), tags=list(dict.fromkeys(tags)))

    def _replace_marker_tags(self, marker_id: str, tags: list[str]) -> None:
        self._db().execute("DELETE FROM marker_tags WHERE marker_id = ?", (marker_id,))
        for tag in dict.fromkeys(tags):
            self._db().execute("INSERT OR IGNORE INTO tags(name) VALUES (?)", (tag,))
            self._db().execute("INSERT INTO marker_tags(marker_id, tag_name) VALUES (?, ?)", (marker_id, tag))

    def delete_marker(self, asset_id: str, marker_id: str) -> bool:
        self._validate_identifier(marker_id, "marker")
        with self._lock, self._db():
            cursor = self._db().execute("DELETE FROM markers WHERE marker_id = ? AND asset_id = ?", (marker_id, asset_id))
        return cursor.rowcount > 0

    def create_summary_documents(
        self, documents: list[SummaryDocument]
    ) -> list[SummaryDocument]:
        if not documents:
            return []
        known_documents = {
            document.document_id: document
            for asset_id in {document.asset_id for document in documents}
            for document in self.load_summary_documents(asset_id)
        }
        known_documents.update(
            {document.document_id: document for document in documents}
        )
        for document in documents:
            self._validate_identifier(document.document_id, "document")
            self._validate_asset_id(document.asset_id)
            if document.parent_document_id is None:
                continue
            self._validate_identifier(document.parent_document_id, "document")
            parent = known_documents.get(document.parent_document_id)
            if parent is None or parent.asset_id != document.asset_id:
                raise ValueError("子文档的主文档不存在")
            if parent.parent_document_id is not None:
                raise ValueError("总结文档只允许一级子文档")
        with self._lock, self._db():
            for document in documents:
                values = document.model_dump(mode="json", exclude={"markdown"})
                columns = tuple(values)
                self._db().execute(
                    f"INSERT INTO summary_documents ({', '.join(columns)}) "
                    f"VALUES ({', '.join('?' for _ in columns)})",
                    tuple(values[column] for column in columns),
                )
        return [document.model_copy(deep=True) for document in documents]

    def load_summary_document(self, document_id: str) -> SummaryDocument | None:
        self._validate_identifier(document_id, "document")
        row = self._db().execute(
            "SELECT * FROM summary_documents WHERE document_id = ?",
            (document_id,),
        ).fetchone()
        return self._summary_document_from_row(row) if row else None

    def load_summary_documents(self, asset_id: str) -> list[SummaryDocument]:
        self._validate_asset_id(asset_id)
        rows = self._db().execute(
            "SELECT * FROM summary_documents WHERE asset_id = ? "
            "ORDER BY parent_document_id IS NOT NULL, position, created_at",
            (asset_id,),
        ).fetchall()
        return [self._summary_document_from_row(row) for row in rows]

    def update_summary_document(
        self,
        document_id: str,
        expected_revision: int,
        *,
        title: str | None = None,
        relative_path: str | None = None,
        content_digest: str | None = None,
        position: int | None = None,
    ) -> SummaryDocument | None:
        self._validate_identifier(document_id, "document")
        assignments: list[str] = []
        values: list[object] = []
        for field_name, value in (
            ("title", title),
            ("relative_path", relative_path),
            ("content_digest", content_digest),
            ("position", position),
        ):
            if value is not None:
                assignments.append(f"{field_name} = ?")
                values.append(value)
        assignments.extend(("revision = revision + 1", "updated_at = ?"))
        values.append(datetime.now(UTC).isoformat())
        values.extend((document_id, expected_revision))
        with self._lock, self._db():
            cursor = self._db().execute(
                f"UPDATE summary_documents SET {', '.join(assignments)} "
                "WHERE document_id = ? AND revision = ?",
                tuple(values),
            )
        return self.load_summary_document(document_id) if cursor.rowcount else None

    def refresh_summary_document_index(
        self,
        document: SummaryDocument,
        *,
        increment_revision: bool = False,
    ) -> SummaryDocument:
        values: list[object] = [
            document.parent_document_id,
            document.title,
            document.relative_path,
            document.content_digest,
            document.position,
            document.updated_at.isoformat(),
        ]
        revision_assignment = "revision + 1" if increment_revision else "?"
        if not increment_revision:
            values.append(document.revision)
        values.append(document.document_id)
        with self._lock, self._db():
            self._db().execute(
                "UPDATE summary_documents SET parent_document_id = ?, title = ?, "
                "relative_path = ?, content_digest = ?, position = ?, updated_at = ?, "
                f"revision = {revision_assignment} WHERE document_id = ?",
                tuple(values),
            )
        refreshed = self.load_summary_document(document.document_id)
        if refreshed is None:
            raise ValueError("总结文档不存在")
        return refreshed

    def reorder_summary_documents(self, parent_document_id: str, document_ids: list[str]) -> None:
        parent = self.load_summary_document(parent_document_id)
        if parent is None or parent.parent_document_id is not None:
            raise ValueError("主文档不存在")
        current_ids = {
            document.document_id
            for document in self.load_summary_documents(parent.asset_id)
            if document.parent_document_id == parent_document_id
        }
        if set(document_ids) != current_ids or len(document_ids) != len(current_ids):
            raise ValueError("排序列表必须包含全部子文档且不能重复")
        now = datetime.now(UTC).isoformat()
        with self._lock, self._db():
            for position, document_id in enumerate(document_ids):
                self._db().execute(
                    "UPDATE summary_documents SET position = ?, revision = revision + 1, "
                    "updated_at = ? WHERE document_id = ?",
                    (position, now, document_id),
                )

    def delete_summary_document(self, document_id: str) -> bool:
        document = self.load_summary_document(document_id)
        if document is None:
            return False
        if document.parent_document_id is None:
            raise ValueError("主文档不能单独删除")
        with self._lock, self._db():
            cursor = self._db().execute(
                "DELETE FROM summary_documents WHERE document_id = ?",
                (document_id,),
            )
        return cursor.rowcount > 0

    def save_summary_conversation(self, conversation: SummaryConversation) -> None:
        self._validate_identifier(conversation.conversation_id, "conversation")
        values = conversation.model_dump(mode="json")
        columns = tuple(values)
        with self._lock, self._db():
            self._db().execute(
                f"INSERT INTO summary_conversations ({', '.join(columns)}) "
                f"VALUES ({', '.join('?' for _ in columns)}) "
                "ON CONFLICT(conversation_id) DO UPDATE SET updated_at=excluded.updated_at",
                tuple(values[column] for column in columns),
            )

    def load_summary_conversations(self, asset_id: str) -> list[SummaryConversation]:
        rows = (
            self._db()
            .execute(
                "SELECT * FROM summary_conversations WHERE asset_id = ? "
                "ORDER BY updated_at DESC, created_at DESC",
                (asset_id,),
            )
            .fetchall()
        )
        return [SummaryConversation.model_validate(dict(row)) for row in rows]

    def load_summary_conversation_by_id(
        self, conversation_id: str
    ) -> SummaryConversation | None:
        self._validate_identifier(conversation_id, "conversation")
        row = (
            self._db()
            .execute(
                "SELECT * FROM summary_conversations WHERE conversation_id = ?",
                (conversation_id,),
            )
            .fetchone()
        )
        return SummaryConversation.model_validate(dict(row)) if row else None

    def update_summary_conversation_title(
        self,
        conversation_id: str,
        title: str,
        updated_at: datetime,
    ) -> SummaryConversation | None:
        self._validate_identifier(conversation_id, "conversation")
        with self._lock, self._db():
            self._db().execute(
                "UPDATE summary_conversations SET title = ?, updated_at = ? "
                "WHERE conversation_id = ?",
                (title, updated_at.isoformat(), conversation_id),
            )
        return self.load_summary_conversation_by_id(conversation_id)

    def delete_summary_conversation(self, conversation_id: str) -> bool:
        self._validate_identifier(conversation_id, "conversation")
        with self._lock, self._db():
            cursor = self._db().execute(
                "DELETE FROM summary_conversations WHERE conversation_id = ?",
                (conversation_id,),
            )
        return cursor.rowcount > 0

    def save_summary_message(self, message: SummaryMessage) -> None:
        self._validate_identifier(message.message_id, "message")
        values = message.model_dump(mode="json")
        columns = tuple(values)
        with self._lock, self._db():
            self._db().execute(
                f"INSERT INTO summary_messages ({', '.join(columns)}) "
                f"VALUES ({', '.join('?' for _ in columns)})",
                tuple(values[column] for column in columns),
            )
            self._db().execute(
                "UPDATE summary_conversations SET updated_at = ? "
                "WHERE conversation_id = ?",
                (message.created_at.isoformat(), message.conversation_id),
            )

    def load_summary_messages(self, conversation_id: str) -> list[SummaryMessage]:
        rows = (
            self._db()
            .execute(
                "SELECT * FROM summary_messages WHERE conversation_id = ? ORDER BY created_at",
                (conversation_id,),
            )
            .fetchall()
        )
        return [SummaryMessage.model_validate(dict(row)) for row in rows]

    def save_summary_proposal(self, proposal: SummaryEditProposal) -> None:
        self._validate_identifier(proposal.proposal_id, "proposal")
        values = proposal.model_dump(mode="json")
        columns = tuple(values)
        updates = ", ".join(f"{column}=excluded.{column}" for column in columns[1:])
        with self._lock, self._db():
            self._db().execute(
                f"INSERT INTO summary_proposals ({', '.join(columns)}) "
                f"VALUES ({', '.join('?' for _ in columns)}) "
                f"ON CONFLICT(proposal_id) DO UPDATE SET {updates}",
                tuple(_sqlite_value(values[column]) for column in columns),
            )

    def load_summary_proposal(self, proposal_id: str) -> SummaryEditProposal | None:
        self._validate_identifier(proposal_id, "proposal")
        row = self._db().execute(
            "SELECT * FROM summary_proposals WHERE proposal_id = ?",
            (proposal_id,),
        ).fetchone()
        if row is None:
            return None
        values = dict(row)
        values["suggested_subdocuments"] = json.loads(values["suggested_subdocuments"])
        values["media_suggestions"] = json.loads(values["media_suggestions"])
        return SummaryEditProposal.model_validate(values)

    def load_summary_proposals(self, conversation_id: str) -> list[SummaryEditProposal]:
        rows = self._db().execute(
            "SELECT proposal_id FROM summary_proposals WHERE conversation_id = ? ORDER BY created_at",
            (conversation_id,),
        ).fetchall()
        return [
            proposal
            for row in rows
            if (proposal := self.load_summary_proposal(row["proposal_id"])) is not None
        ]

    def save_summary_agent_run(self, run: SummaryAgentRun) -> None:
        self._validate_identifier(run.run_id, "run")
        values = run.model_dump(mode="json")
        columns = tuple(values)
        updates = ", ".join(f"{column}=excluded.{column}" for column in columns[1:])
        with self._lock, self._db():
            self._db().execute(
                f"INSERT INTO summary_agent_runs ({', '.join(columns)}) "
                f"VALUES ({', '.join('?' for _ in columns)}) "
                f"ON CONFLICT(run_id) DO UPDATE SET {updates}",
                tuple(values[column] for column in columns),
            )

    def load_summary_agent_run(self, run_id: str) -> SummaryAgentRun | None:
        self._validate_identifier(run_id, "run")
        row = self._db().execute(
            "SELECT * FROM summary_agent_runs WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        return SummaryAgentRun.model_validate(dict(row)) if row else None

    def load_summary_agent_runs(self) -> list[SummaryAgentRun]:
        rows = self._db().execute(
            "SELECT * FROM summary_agent_runs ORDER BY created_at"
        ).fetchall()
        return [SummaryAgentRun.model_validate(dict(row)) for row in rows]

    def save_summary_media(self, media: SummaryMediaArtifact) -> None:
        self._validate_identifier(media.media_id, "media")
        values = media.model_dump(mode="json")
        columns = tuple(values)
        with self._lock, self._db():
            self._db().execute(
                f"INSERT INTO summary_media ({', '.join(columns)}) "
                f"VALUES ({', '.join('?' for _ in columns)})",
                tuple(values[column] for column in columns),
            )

    def load_summary_media(self, asset_id: str) -> list[SummaryMediaArtifact]:
        rows = self._db().execute(
            "SELECT * FROM summary_media WHERE asset_id = ? ORDER BY created_at",
            (asset_id,),
        ).fetchall()
        return [SummaryMediaArtifact.model_validate(dict(row)) for row in rows]

    def replace_summary_media_index(
        self,
        asset_id: str,
        media: list[SummaryMediaArtifact],
    ) -> None:
        if any(artifact.asset_id != asset_id for artifact in media):
            raise ValueError("总结媒体不属于当前素材")
        with self._lock, self._db():
            self._db().execute("DELETE FROM summary_media WHERE asset_id = ?", (asset_id,))
            for artifact in media:
                self._validate_identifier(artifact.media_id, "media")
                values = artifact.model_dump(mode="json")
                columns = tuple(values)
                self._db().execute(
                    f"INSERT INTO summary_media ({', '.join(columns)}) "
                    f"VALUES ({', '.join('?' for _ in columns)})",
                    tuple(values[column] for column in columns),
                )

    def _summary_document_from_row(self, row: sqlite3.Row) -> SummaryDocument:
        values = dict(row)
        relative_path = values["relative_path"]
        try:
            markdown = read_markdown(
                self.asset_directory(values["asset_id"]),
                relative_path,
            )
        except (OSError, UnicodeError, ValueError) as error:
            raise InvalidLibraryError("总结 Markdown 文件缺失或路径无效") from error
        return SummaryDocument.model_validate({**values, "markdown": markdown})

    def _db(self) -> sqlite3.Connection:
        if self._connection is None:
            raise RuntimeError("资料库未打开")
        return self._connection

    def _table_exists(self, table_name: str) -> bool:
        return self._db().execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table_name,),
        ).fetchone() is not None

    @staticmethod
    def _validate_identifier(identifier: str, prefix: str) -> None:
        expected_prefix = f"{prefix}-"
        suffix = identifier.removeprefix(expected_prefix)
        if not identifier.startswith(expected_prefix) or len(suffix) != HEX_IDENTIFIER_LENGTH or any(character not in "0123456789abcdef" for character in suffix):
            raise ValueError(f"{prefix} ID 无效")

    @staticmethod
    def _validate_asset_id(asset_id: str) -> None:
        if not is_uuid7(asset_id):
            raise ValueError("asset ID 无效")


def _sqlite_value(value: object) -> object:
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return value


def _agent_job_from_row(row: sqlite3.Row) -> AgentJob:
    values = dict(row)
    for field_name in ("segment_indices", "question"):
        if values[field_name] is not None:
            values[field_name] = json.loads(values[field_name])
    return AgentJob.model_validate(values)


def _legacy_asset_uuid(asset_id: str) -> str | None:
    prefix = "asset-"
    hexadecimal = asset_id.removeprefix(prefix)
    if not asset_id.startswith(prefix) or len(hexadecimal) != HEX_IDENTIFIER_LENGTH:
        return None
    try:
        candidate = str(UUID(hex=hexadecimal))
    except ValueError:
        return None
    return candidate if is_uuid7(candidate) else None


_ASSET_REFERENCE_COLUMNS = (
    ("download_jobs", "asset_id"),
    ("analysis_jobs", "asset_id"),
    ("transcript_segments", "asset_id"),
    ("transcripts", "asset_id"),
    ("timeline_segments", "asset_id"),
    ("markers", "asset_id"),
    ("asset_relationships", "source_asset_id"),
    ("asset_relationships", "target_asset_id"),
    ("artifacts", "asset_id"),
    ("assets", "asset_id"),
)


_INITIAL_SCHEMA = """
CREATE TABLE assets (
    asset_id TEXT PRIMARY KEY, media_type TEXT NOT NULL DEFAULT 'video', source_url TEXT NOT NULL, source_platform TEXT NOT NULL,
    source_video_id TEXT, title TEXT NOT NULL, author_name TEXT, description TEXT,
    duration_seconds REAL, width INTEGER, height INTEGER, video_codec TEXT, audio_codec TEXT,
    playback_path TEXT, thumbnail_path TEXT, remote_thumbnail_url TEXT, thumbnail_sprite_path TEXT,
    thumbnail_tile_width INTEGER, thumbnail_tile_height INTEGER, thumbnail_interval_seconds REAL,
    thumbnail_columns INTEGER, thumbnail_total_tiles INTEGER, status TEXT NOT NULL,
    error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(source_platform, source_video_id)
);
CREATE TABLE download_jobs (
    job_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    stage TEXT NOT NULL, progress_percent REAL NOT NULL, message TEXT NOT NULL,
    error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE analysis_jobs (
    job_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    operation TEXT NOT NULL, mode TEXT NOT NULL, ai_model_id TEXT, strategy TEXT NOT NULL, stage TEXT NOT NULL, progress_percent REAL NOT NULL,
    message TEXT NOT NULL, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
    position INTEGER NOT NULL, start_seconds REAL NOT NULL, end_seconds REAL NOT NULL, title TEXT NOT NULL,
    detailed_summary TEXT, transcript_text TEXT, speaker_name TEXT, visual_description TEXT, ocr_text TEXT,
    UNIQUE(asset_id, position)
);
CREATE TABLE markers (
    marker_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    time_seconds REAL NOT NULL
);
CREATE TABLE tags (name TEXT PRIMARY KEY);
CREATE TABLE marker_tags (marker_id TEXT NOT NULL REFERENCES markers(marker_id) ON DELETE CASCADE, tag_name TEXT NOT NULL REFERENCES tags(name), PRIMARY KEY(marker_id, tag_name));
CREATE TABLE segment_tags (segment_id TEXT NOT NULL REFERENCES timeline_segments(segment_id) ON DELETE CASCADE, tag_name TEXT NOT NULL REFERENCES tags(name), PRIMARY KEY(segment_id, tag_name));
CREATE TABLE segment_frames (segment_id TEXT NOT NULL REFERENCES timeline_segments(segment_id) ON DELETE CASCADE, position INTEGER NOT NULL, relative_path TEXT NOT NULL, PRIMARY KEY(segment_id, position));
CREATE TABLE segment_markers (segment_id TEXT NOT NULL REFERENCES timeline_segments(segment_id) ON DELETE CASCADE, marker_id TEXT NOT NULL REFERENCES markers(marker_id) ON DELETE CASCADE, PRIMARY KEY(segment_id, marker_id));
CREATE TABLE analysis_job_markers (job_id TEXT NOT NULL REFERENCES analysis_jobs(job_id) ON DELETE CASCADE, marker_id TEXT NOT NULL, PRIMARY KEY(job_id, marker_id));
CREATE TABLE analysis_job_capabilities (job_id TEXT NOT NULL REFERENCES analysis_jobs(job_id) ON DELETE CASCADE, capability TEXT NOT NULL, PRIMARY KEY(job_id, capability));
CREATE TABLE asset_relationships (source_asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE, target_asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE, relation_type TEXT NOT NULL, PRIMARY KEY(source_asset_id, target_asset_id, relation_type));
CREATE TABLE artifacts (artifact_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE, artifact_type TEXT NOT NULL, relative_path TEXT NOT NULL, checksum TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX assets_created_at_index ON assets(created_at DESC);
CREATE INDEX markers_asset_time_index ON markers(asset_id, time_seconds);
CREATE INDEX agent_jobs_asset_created_index ON agent_jobs(asset_id, created_at DESC);
CREATE TABLE summary_documents (
    document_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    parent_document_id TEXT REFERENCES summary_documents(document_id) ON DELETE CASCADE,
    title TEXT NOT NULL, relative_path TEXT NOT NULL, content_digest TEXT NOT NULL,
    position INTEGER NOT NULL, revision INTEGER NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX summary_documents_root_asset_index
ON summary_documents(asset_id) WHERE parent_document_id IS NULL;
CREATE INDEX summary_documents_parent_position_index
ON summary_documents(parent_document_id, position);
CREATE TABLE summary_conversations (
    conversation_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    root_document_id TEXT NOT NULL REFERENCES summary_documents(document_id) ON DELETE CASCADE,
    title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX summary_conversations_asset_updated_index
ON summary_conversations(asset_id, updated_at DESC);
CREATE TABLE summary_messages (
    message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES summary_conversations(conversation_id) ON DELETE CASCADE,
    role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX summary_messages_conversation_created_index
ON summary_messages(conversation_id, created_at);
CREATE TABLE summary_proposals (
    proposal_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES summary_conversations(conversation_id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES summary_documents(document_id) ON DELETE CASCADE,
    base_revision INTEGER NOT NULL, proposed_markdown TEXT NOT NULL, explanation TEXT NOT NULL,
    diff TEXT NOT NULL, suggested_subdocuments TEXT NOT NULL, media_suggestions TEXT NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE summary_agent_runs (
    run_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES summary_conversations(conversation_id) ON DELETE CASCADE,
    stage TEXT NOT NULL, assistant_message_id TEXT, proposal_id TEXT, error_message TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE summary_media (
    media_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES summary_documents(document_id) ON DELETE CASCADE,
    media_type TEXT NOT NULL, relative_path TEXT NOT NULL, caption TEXT NOT NULL,
    start_seconds REAL NOT NULL, end_seconds REAL, created_at TEXT NOT NULL
);
"""


_AGENT_JOB_SCHEMA = """
CREATE TABLE IF NOT EXISTS agent_jobs (
    job_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    agent_type TEXT NOT NULL, execution_mode TEXT NOT NULL, stage TEXT NOT NULL,
    progress_percent REAL NOT NULL, message TEXT NOT NULL, ai_model_id TEXT NOT NULL,
    segment_indices TEXT, transcript_checksum TEXT NOT NULL, question TEXT,
    error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_jobs_asset_created_index
ON agent_jobs(asset_id, created_at DESC);
"""


_SUMMARY_SCHEMA = """
CREATE TABLE IF NOT EXISTS summary_documents (
    document_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    parent_document_id TEXT REFERENCES summary_documents(document_id) ON DELETE CASCADE,
    title TEXT NOT NULL, markdown TEXT NOT NULL, position INTEGER NOT NULL, revision INTEGER NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS summary_documents_root_asset_index
ON summary_documents(asset_id) WHERE parent_document_id IS NULL;
CREATE INDEX IF NOT EXISTS summary_documents_parent_position_index
ON summary_documents(parent_document_id, position);
CREATE TABLE IF NOT EXISTS summary_conversations (
    conversation_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    root_document_id TEXT NOT NULL REFERENCES summary_documents(document_id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(asset_id)
);
CREATE TABLE IF NOT EXISTS summary_messages (
    message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES summary_conversations(conversation_id) ON DELETE CASCADE,
    role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS summary_messages_conversation_created_index
ON summary_messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS summary_proposals (
    proposal_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES summary_conversations(conversation_id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES summary_documents(document_id) ON DELETE CASCADE,
    base_revision INTEGER NOT NULL, proposed_markdown TEXT NOT NULL, explanation TEXT NOT NULL,
    diff TEXT NOT NULL, suggested_subdocuments TEXT NOT NULL, media_suggestions TEXT NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS summary_agent_runs (
    run_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES summary_conversations(conversation_id) ON DELETE CASCADE,
    stage TEXT NOT NULL, assistant_message_id TEXT, proposal_id TEXT, error_message TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS summary_media (
    media_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES summary_documents(document_id) ON DELETE CASCADE,
    media_type TEXT NOT NULL, relative_path TEXT NOT NULL, caption TEXT NOT NULL,
    start_seconds REAL NOT NULL, end_seconds REAL, created_at TEXT NOT NULL
);
"""


_SUMMARY_DOCUMENTS_V7_TABLE = """
CREATE TABLE summary_documents_v7 (
    document_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    parent_document_id TEXT REFERENCES summary_documents(document_id) ON DELETE CASCADE,
    title TEXT NOT NULL, relative_path TEXT NOT NULL, content_digest TEXT NOT NULL,
    position INTEGER NOT NULL, revision INTEGER NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)
"""


_SUMMARY_DOCUMENT_INDEXES = (
    "CREATE UNIQUE INDEX summary_documents_root_asset_index "
    "ON summary_documents(asset_id) WHERE parent_document_id IS NULL",
    "CREATE INDEX summary_documents_parent_position_index "
    "ON summary_documents(parent_document_id, position)",
)


_SUMMARY_CONVERSATIONS_V9_TABLE = """
CREATE TABLE summary_conversations_v9 (
    conversation_id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    root_document_id TEXT NOT NULL REFERENCES summary_documents(document_id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
"""


_SUMMARY_CONVERSATIONS_ASSET_UPDATED_INDEX = (
    "CREATE INDEX summary_conversations_asset_updated_index "
    "ON summary_conversations(asset_id, updated_at DESC)"
)
