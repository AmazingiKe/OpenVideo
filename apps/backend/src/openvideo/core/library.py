from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock

import portalocker
from pydantic import BaseModel

from openvideo.core.analysis_models import AnalysisJob, Transcript, TranscriptSegment
from openvideo.core.identifiers import uuid7
from openvideo.core.models import (
    DownloadJob,
    DownloadStage,
    MediaAsset,
    MediaAssetResponse,
    MediaAssetStatus,
    MediaMarker,
    MediaSegment,
    SourcePlatform,
    ThumbnailStoryboardResponse,
    ThumbnailStoryboardTile,
)
from openvideo.core.thumbnails import ThumbnailStoryboard, build_thumbnail_tiles


FORMAT_VERSION = 1
DATABASE_VERSION = 1
MANIFEST_FILE_NAME = "library.json"
DATABASE_FILE_NAME = "openvideo.sqlite3"
LOCK_FILE_NAME = ".openvideo.lock"
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
    """一个打开会话独占一个可整体移动的资料库，并以 SQLite 作为业务数据源。"""

    def __init__(self, root_path: Path, manifest: LibraryManifest) -> None:
        self.library_path = root_path.resolve()
        self.manifest = manifest
        self.assets_path = self.library_path / "assets"
        self._connection: sqlite3.Connection | None = None
        self._file_lock: portalocker.Lock | None = None
        self._lock = RLock()

    @classmethod
    def create_in_parent(cls, parent_path: Path, name: str) -> MediaLibrary:
        normalized_name = name.strip()
        if not normalized_name or Path(normalized_name).name != normalized_name:
            raise InvalidLibraryError("资料库名称无效")
        root_path = parent_path.resolve() / f"{normalized_name}.openvideo-library"
        if root_path.exists():
            raise InvalidLibraryError("目标资料库目录已存在")
        root_path.mkdir(parents=False)
        try:
            return cls._initialize(root_path, normalized_name)
        except Exception:
            if root_path.exists() and not any(root_path.iterdir()):
                root_path.rmdir()
            raise

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
        self._validate_identifier(asset.asset_id, "asset")
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

    def get(self, asset_id: str) -> MediaAsset | None:
        self._validate_identifier(asset_id, "asset")
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
        self._validate_identifier(asset_id, "asset")
        directory = (self.assets_path / asset_id).resolve()
        if not directory.is_relative_to(self.assets_path):
            raise ValueError("资源目录越出资料库")
        return directory

    def media_directory(self, asset_id: str) -> Path:
        directory = self.asset_directory(asset_id) / "media"
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def artifacts_directory(self, asset_id: str) -> Path:
        directory = self.asset_directory(asset_id) / "artifacts"
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
        with self._lock, self._db():
            self._db().execute("DELETE FROM transcript_segments WHERE asset_id = ?", (transcript.asset_id,))
            self._db().execute(
                "INSERT INTO transcripts(asset_id, language, created_at) VALUES (?, ?, ?) "
                "ON CONFLICT(asset_id) DO UPDATE SET language=excluded.language, created_at=excluded.created_at",
                (transcript.asset_id, transcript.language, transcript.created_at.isoformat()),
            )
            self._db().executemany(
                "INSERT INTO transcript_segments(asset_id, position, start_seconds, end_seconds, text) VALUES (?, ?, ?, ?, ?)",
                [(transcript.asset_id, index, segment.start_seconds, segment.end_seconds, segment.text) for index, segment in enumerate(transcript.segments)],
            )

    def load_transcript(self, asset_id: str) -> Transcript | None:
        row = self._db().execute("SELECT * FROM transcripts WHERE asset_id = ?", (asset_id,)).fetchone()
        if not row:
            return None
        segments = self._db().execute(
            "SELECT start_seconds, end_seconds, text FROM transcript_segments WHERE asset_id = ? ORDER BY position",
            (asset_id,),
        ).fetchall()
        return Transcript(
            asset_id=asset_id,
            language=row["language"],
            created_at=row["created_at"],
            segments=[TranscriptSegment.model_validate(dict(segment)) for segment in segments],
        )

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

    def load_analysis_jobs(self) -> list[AnalysisJob]:
        rows = self._db().execute("SELECT * FROM analysis_jobs ORDER BY created_at").fetchall()
        jobs = []
        for row in rows:
            job_id = row["job_id"]
            values = dict(row)
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

    def _db(self) -> sqlite3.Connection:
        if self._connection is None:
            raise RuntimeError("资料库未打开")
        return self._connection

    @staticmethod
    def _validate_identifier(identifier: str, prefix: str) -> None:
        expected_prefix = f"{prefix}-"
        suffix = identifier.removeprefix(expected_prefix)
        if not identifier.startswith(expected_prefix) or len(suffix) != HEX_IDENTIFIER_LENGTH or any(character not in "0123456789abcdef" for character in suffix):
            raise ValueError(f"{prefix} ID 无效")


def _sqlite_value(value: object) -> object:
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return value


_INITIAL_SCHEMA = """
CREATE TABLE assets (
    asset_id TEXT PRIMARY KEY, source_url TEXT NOT NULL, source_platform TEXT NOT NULL,
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
    operation TEXT NOT NULL, mode TEXT NOT NULL, stage TEXT NOT NULL, progress_percent REAL NOT NULL,
    message TEXT NOT NULL, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE transcripts (asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE, language TEXT, created_at TEXT NOT NULL);
CREATE TABLE transcript_segments (
    asset_id TEXT NOT NULL REFERENCES transcripts(asset_id) ON DELETE CASCADE, position INTEGER NOT NULL,
    start_seconds REAL NOT NULL, end_seconds REAL NOT NULL, text TEXT NOT NULL, PRIMARY KEY(asset_id, position)
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
"""
