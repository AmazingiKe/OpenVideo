from __future__ import annotations

import json
import shutil
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from uuid import UUID

import portalocker
from pydantic import BaseModel

from openvideo.core.agent_models import AgentJob
from openvideo.core.agent_runtime_models import (
    AgentEvent,
    AgentEventType,
    AgentRun,
    AgentRunStage,
    AgentSession,
)
from openvideo.core.analysis_models import AnalysisJob
from openvideo.core.download_models import DownloadJob, DownloadStage
from openvideo.core.identifiers import is_uuid7, uuid7
from openvideo.core.folder_models import Folder, FolderManifest, FolderResponse
from openvideo.core.library_files import (
    ARTIFACTS_DIRECTORY_NAME,
    ASSET_METADATA_FILE_NAME,
    MARKERS_FILE_NAME,
    TIMELINE_FILE_NAME,
    TRANSCRIPT_FILE_NAME,
    TRANSCRIPTION_METADATA_FILE_NAME,
    IndexIssue,
    MarkersFile,
    SummaryConversationFile,
    TimelineFile,
    atomic_write_model,
    conversation_file_path,
    metadata_from_asset,
)
from openvideo.core.library_index import (
    load_index_issues,
    open_index_database,
    remove_asset_projection,
    synchronize_asset,
    synchronize_folders,
)
from openvideo.core.media_models import (
    MediaAsset,
    MediaAssetResponse,
    MediaAssetStatus,
    MediaMarker,
    MediaSegment,
    SourcePlatform,
    ThumbnailStoryboardResponse,
    ThumbnailStoryboardTile,
)
from openvideo.core.marker_agent_models import MarkerProposal
from openvideo.core.transcription_models import Transcript, TranscriptionMetadata
from openvideo.core.summary_files import load_manifest, read_markdown, write_manifest
from openvideo.core.summary_models import (
    SummaryAgentRun,
    SummaryConversation,
    SummaryDocument,
    SummaryEditProposal,
    SummaryMediaArtifact,
    SummaryMessage,
)
from openvideo.core.thumbnails import ThumbnailStoryboard, build_thumbnail_tiles


FORMAT_VERSION = 2
MANIFEST_FILE_NAME = "library.json"
FOLDER_MANIFEST_FILE_NAME = "folders.json"
AGENT_CHECKPOINT_DATABASE_FILE_NAME = "agent_checkpoints.sqlite3"
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


class FolderNotFoundError(LibraryError):
    code = "folder_not_found"


class FolderConflictError(LibraryError):
    code = "folder_conflict"


class LibraryManifest(BaseModel):
    library_id: str
    name: str
    format_version: int
    created_at: datetime


class LibraryDescription(LibraryManifest):
    root_path: str
    index_issues: list[IndexIssue]


class MediaLibrary:
    """以业务文件保存用户成果，并用 SQLite 提供可重建查询投影。"""

    def __init__(self, root_path: Path, manifest: LibraryManifest) -> None:
        self.library_path = root_path.resolve()
        self.manifest = manifest
        self.assets_path = self.library_path / "assets"
        self.folder_manifest_path = self.library_path / FOLDER_MANIFEST_FILE_NAME
        self._folders = self._load_folder_manifest()
        self._connection: sqlite3.Connection | None = None
        self._file_lock: portalocker.Lock | None = None
        self._lock = RLock()

    @classmethod
    def initialize_directory(cls, root_path: Path) -> MediaLibrary:
        if root_path.is_symlink():
            raise InvalidLibraryError("资料库根目录不能是符号链接")
        resolved_path = root_path.resolve()
        if not resolved_path.is_dir():
            raise InvalidLibraryError("指定目录不存在")
        if any(resolved_path.iterdir()):
            raise InvalidLibraryError("只能初始化空目录")
        manifest = LibraryManifest(
            library_id=f"library-{uuid7().hex}",
            name=resolved_path.name,
            format_version=FORMAT_VERSION,
            created_at=datetime.now(UTC),
        )
        for directory_name in ("assets", "cache", "temp"):
            (resolved_path / directory_name).mkdir()
        atomic_write_model(resolved_path / MANIFEST_FILE_NAME, manifest)
        atomic_write_model(
            resolved_path / FOLDER_MANIFEST_FILE_NAME,
            FolderManifest(),
        )
        library = cls(resolved_path, manifest)
        library._open_session()
        return library

    @classmethod
    def open(cls, root_path: Path) -> MediaLibrary:
        if root_path.is_symlink():
            raise InvalidLibraryError("资料库根目录不能是符号链接")
        resolved_path = root_path.resolve()
        manifest_path = resolved_path / MANIFEST_FILE_NAME
        try:
            if resolved_path.is_symlink() or not resolved_path.is_dir():
                raise ValueError("资料库根目录无效")
            manifest = LibraryManifest.model_validate_json(
                manifest_path.read_text(encoding="utf-8")
            )
        except (OSError, ValueError) as error:
            raise InvalidLibraryError("该目录不是有效的 OpenVideo 资料库") from error
        cls._validate_identifier(manifest.library_id, "library")
        if manifest.format_version != FORMAT_VERSION:
            raise InvalidLibraryError(
                f"资料库格式版本 {manifest.format_version} 不受支持，当前仅支持 v{FORMAT_VERSION}"
            )
        required_paths = [
            resolved_path / "assets",
            resolved_path / "cache",
            resolved_path / "temp",
        ]
        if any(path.is_symlink() or not path.is_dir() for path in required_paths):
            raise InvalidLibraryError("资料库目录结构不完整或包含符号链接")
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
            self._connection = open_index_database(self.library_path, self.assets_path)
            self._file_lock = lock
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
        return LibraryDescription(
            **self.manifest.model_dump(),
            root_path=str(self.library_path),
            index_issues=load_index_issues(self._db()),
        )

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
                (self.library_path / LOCK_FILE_NAME).unlink(missing_ok=True)

    def save(self, asset: MediaAsset) -> None:
        self._validate_asset_id(asset.asset_id)
        asset.updated_at = datetime.now(UTC)
        with self._lock:
            self._write_asset_metadata(asset)
            synchronize_asset(self._db(), self.assets_path, asset.asset_id)

    def get(self, asset_id: str) -> MediaAsset | None:
        self._validate_asset_id(asset_id)
        row = (
            self._db()
            .execute("SELECT * FROM assets WHERE asset_id = ?", (asset_id,))
            .fetchone()
        )
        return MediaAsset.model_validate(dict(row)) if row else None

    def list(
        self,
        *,
        folder_id: str | None = None,
        uncategorized: bool = False,
        search: str | None = None,
        sort_by: str = "created_at",
        sort_order: str = "desc",
    ) -> list[MediaAsset]:
        sort_columns = {
            "created_at": "created_at",
            "title": "title COLLATE NOCASE",
            "duration": "duration_seconds",
        }
        if sort_by not in sort_columns or sort_order not in {"asc", "desc"}:
            raise ValueError("素材排序参数无效")
        clauses: list[str] = []
        parameters: list[object] = []
        if folder_id is not None:
            self._require_folder(folder_id)
            clauses.append("folder_id = ?")
            parameters.append(folder_id)
        elif uncategorized:
            clauses.append("folder_id IS NULL")
        normalized_search = search.strip() if search else ""
        if normalized_search:
            clauses.append(
                "(title LIKE ? COLLATE NOCASE OR author_name LIKE ? COLLATE NOCASE)"
            )
            pattern = f"%{normalized_search}%"
            parameters.extend((pattern, pattern))
        where_clause = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        order_column = sort_columns[sort_by]
        rows = (
            self._db()
            .execute(
                f"SELECT * FROM assets{where_clause} "
                f"ORDER BY {order_column} {sort_order.upper()}, asset_id ASC",
                tuple(parameters),
            )
            .fetchall()
        )
        return [MediaAsset.model_validate(dict(row)) for row in rows]

    def list_folders(self) -> list[FolderResponse]:
        rows = (
            self._db()
            .execute(
                "SELECT folder.*, "
                "(SELECT COUNT(*) FROM assets WHERE folder_id = folder.folder_id) "
                "AS direct_asset_count, "
                "(SELECT COUNT(*) FROM assets asset "
                " JOIN folders owner ON owner.folder_id = asset.folder_id "
                " WHERE owner.materialized_path LIKE folder.materialized_path || '%') "
                "AS recursive_asset_count "
                "FROM folders folder ORDER BY folder.materialized_path"
            )
            .fetchall()
        )
        return [FolderResponse.model_validate(dict(row)) for row in rows]

    def get_folder(self, folder_id: str) -> FolderResponse:
        self._require_folder(folder_id)
        return self._folder_response(folder_id)

    def create_folder(self, name: str, parent_id: str | None = None) -> FolderResponse:
        parent = self._require_folder(parent_id) if parent_id else None
        folder_id = f"folder-{uuid7().hex}"
        path_prefix = parent.materialized_path if parent else "/"
        folder = Folder(
            folder_id=folder_id,
            name=name,
            parent_id=parent_id,
            materialized_path=f"{path_prefix}{folder_id}/",
        )
        with self._lock:
            self._ensure_unique_folder_name(folder.name, folder.parent_id)
            self._folders[folder.folder_id] = folder
            self._write_folder_manifest()
            synchronize_folders(self._db(), self.folder_manifest_path)
        return self._folder_response(folder.folder_id)

    def rename_folder(self, folder_id: str, name: str) -> FolderResponse:
        folder = self._require_folder(folder_id)
        normalized = Folder(
            **folder.model_dump(exclude={"name", "updated_at"}),
            name=name,
            updated_at=datetime.now(UTC),
        )
        with self._lock:
            self._ensure_unique_folder_name(
                normalized.name,
                normalized.parent_id,
                exclude_id=folder_id,
            )
            self._folders[folder_id] = normalized
            self._write_folder_manifest()
            synchronize_folders(self._db(), self.folder_manifest_path)
        return self._folder_response(folder_id)

    def move_folder(self, folder_id: str, parent_id: str | None) -> FolderResponse:
        folder = self._require_folder(folder_id)
        parent = self._require_folder(parent_id) if parent_id else None
        if parent_id == folder_id:
            raise FolderConflictError("文件夹不能移动到自身")
        if parent and parent.materialized_path.startswith(folder.materialized_path):
            raise FolderConflictError("文件夹不能移动到自己的后代")
        self._ensure_unique_folder_name(folder.name, parent_id, exclude_id=folder_id)
        old_path = folder.materialized_path
        new_prefix = parent.materialized_path if parent else "/"
        new_path = f"{new_prefix}{folder_id}/"
        updated_at = datetime.now(UTC)
        with self._lock:
            for descendant_id, descendant in list(self._folders.items()):
                if not descendant.materialized_path.startswith(old_path):
                    continue
                suffix = descendant.materialized_path.removeprefix(old_path)
                values = {"materialized_path": f"{new_path}{suffix}"}
                if descendant_id == folder_id:
                    values["parent_id"] = parent_id
                    values["updated_at"] = updated_at
                self._folders[descendant_id] = descendant.model_copy(update=values)
            self._write_folder_manifest()
            synchronize_folders(self._db(), self.folder_manifest_path)
        return self._folder_response(folder_id)

    def move_assets(
        self, asset_ids: list[str], folder_id: str | None
    ) -> list[MediaAsset]:
        if folder_id is not None:
            self._require_folder(folder_id)
        unique_ids = list(dict.fromkeys(asset_ids))
        assets = [self.get(asset_id) for asset_id in unique_ids]
        if any(asset is None for asset in assets):
            raise ValueError("移动请求包含不存在的素材")
        moved: list[MediaAsset] = []
        with self._lock:
            for asset in assets:
                if asset is None:
                    continue
                asset.folder_id = folder_id
                self.save(asset)
                moved.append(asset)
        return moved

    def folder_asset_ids(self, folder_id: str) -> list[str]:
        folder = self._require_folder(folder_id)
        rows = (
            self._db()
            .execute(
                "SELECT asset.asset_id FROM assets asset "
                "JOIN folders owner ON owner.folder_id = asset.folder_id "
                "WHERE owner.materialized_path LIKE ? ORDER BY asset.asset_id",
                (f"{folder.materialized_path}%",),
            )
            .fetchall()
        )
        return [row[0] for row in rows]

    def delete_folder(self, folder_id: str) -> None:
        folder = self._require_folder(folder_id)
        if self.folder_asset_ids(folder_id):
            raise FolderConflictError("文件夹仍包含素材，不能只删除目录记录")
        subtree_ids = {
            item.folder_id
            for item in self._folders.values()
            if item.materialized_path.startswith(folder.materialized_path)
        }
        with self._lock:
            for descendant_id in subtree_ids:
                self._folders.pop(descendant_id, None)
            self._write_folder_manifest()
            synchronize_folders(self._db(), self.folder_manifest_path)

    def delete_asset(self, asset_id: str) -> None:
        asset = self.get(asset_id)
        if asset is None:
            raise ValueError("媒体资源不存在")
        directory = self.asset_directory(asset_id)
        assets_root = self.assets_path.resolve()
        if not directory.is_relative_to(assets_root) or directory == assets_root:
            raise ValueError("素材目录超出资料库范围")
        if directory.is_symlink():
            raise ValueError("素材目录不能是符号链接")
        with self._lock:
            if directory.exists():
                shutil.rmtree(directory)
            with self._db():
                remove_asset_projection(self._db(), asset_id)

    def find_by_source_video_id(
        self, platform: SourcePlatform, source_video_id: str
    ) -> MediaAsset | None:
        row = (
            self._db()
            .execute(
                "SELECT * FROM assets WHERE source_platform = ? "
                "AND source_video_id = ? COLLATE NOCASE",
                (platform.value, source_video_id),
            )
            .fetchone()
        )
        return MediaAsset.model_validate(dict(row)) if row else None

    def save_download_job(self, job: DownloadJob) -> None:
        self._upsert_runtime_model("download_jobs", job.model_dump(mode="json"))

    def get_download_job(self, job_id: str) -> DownloadJob | None:
        row = (
            self._db()
            .execute("SELECT * FROM download_jobs WHERE job_id = ?", (job_id,))
            .fetchone()
        )
        return DownloadJob.model_validate(dict(row)) if row else None

    def list_download_jobs(self) -> list[DownloadJob]:
        rows = (
            self._db()
            .execute("SELECT * FROM download_jobs ORDER BY created_at DESC")
            .fetchall()
        )
        return [DownloadJob.model_validate(dict(row)) for row in rows]

    def asset_directory(self, asset_id: str) -> Path:
        self._validate_asset_id(asset_id)
        directory = self.assets_path / asset_id
        if directory.exists() and directory.is_symlink():
            raise ValueError("素材目录不能是符号链接")
        resolved = directory.resolve()
        if not resolved.is_relative_to(self.assets_path.resolve()):
            raise ValueError("素材目录超出资料库")
        return resolved

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
        temporary_root = (self.library_path / "temp").resolve()
        directory = (temporary_root / job_id).resolve()
        if not directory.is_relative_to(temporary_root):
            raise ValueError("临时目录超出资料库")
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def resolve_asset_file(
        self, asset: MediaAsset, relative_path: str | None
    ) -> Path | None:
        if not relative_path:
            return None
        asset_directory = self.asset_directory(asset.asset_id)
        candidate = (asset_directory / relative_path).resolve()
        if (
            not candidate.is_relative_to(asset_directory)
            or not candidate.is_file()
            or candidate.is_symlink()
        ):
            return None
        return candidate

    def response_for(self, asset: MediaAsset) -> MediaAssetResponse:
        playback_file = self.resolve_asset_file(asset, asset.playback_path)
        thumbnail_file = self.resolve_asset_file(asset, asset.thumbnail_path)
        excluded_fields = {
            "playback_path",
            "thumbnail_path",
            "remote_thumbnail_url",
            "thumbnail_sprite_path",
            "thumbnail_tile_width",
            "thumbnail_tile_height",
            "thumbnail_interval_seconds",
            "thumbnail_columns",
            "thumbnail_total_tiles",
        }
        return MediaAssetResponse(
            **asset.model_dump(exclude=excluded_fields),
            playback_url=(
                PLAYBACK_ROUTE_TEMPLATE.format(asset_id=asset.asset_id)
                if playback_file
                else None
            ),
            thumbnail_url=(
                THUMBNAIL_ROUTE_TEMPLATE.format(asset_id=asset.asset_id)
                if thumbnail_file
                else None
            ),
            thumbnail_storyboard=self._storyboard_for(asset),
        )

    def save_transcript(self, transcript: Transcript) -> None:
        self._validate_asset_id(transcript.asset_id)
        asset = self.get(transcript.asset_id)
        if asset is None:
            raise ValueError("转录对应的素材不存在")
        with self._lock:
            atomic_write_model(self._transcript_path(transcript.asset_id), transcript)
            self._write_asset_metadata(asset)
            synchronize_asset(self._db(), self.assets_path, transcript.asset_id)

    def save_transcription_metadata(self, metadata: TranscriptionMetadata) -> None:
        """任务详情需要独立于运行进程保存，便于失败诊断和结果追溯。"""
        asset = self.get(metadata.asset_id)
        if asset is None:
            raise ValueError("转录元数据对应的素材不存在")
        output_path = (
            self.artifacts_directory(metadata.asset_id)
            / TRANSCRIPTION_METADATA_FILE_NAME
        )
        with self._lock:
            atomic_write_model(output_path, metadata)
            self._write_asset_metadata(asset)
            synchronize_asset(self._db(), self.assets_path, metadata.asset_id)

    def load_transcription_metadata(
        self, asset_id: str
    ) -> TranscriptionMetadata | None:
        input_path = (
            self.asset_directory(asset_id)
            / ARTIFACTS_DIRECTORY_NAME
            / TRANSCRIPTION_METADATA_FILE_NAME
        )
        return self._load_optional_model(input_path, TranscriptionMetadata, asset_id)

    def load_transcript(self, asset_id: str) -> Transcript | None:
        return self._load_optional_model(
            self._transcript_path(asset_id), Transcript, asset_id
        )

    def save_segments(self, asset_id: str, segments: list[MediaSegment]) -> None:
        self._validate_asset_id(asset_id)
        if any(segment.asset_id != asset_id for segment in segments):
            raise ValueError("时间轴事件不属于同一个媒体素材")
        output = TimelineFile(asset_id=asset_id, segments=segments)
        output_path = self.artifacts_directory(asset_id) / TIMELINE_FILE_NAME
        with self._lock:
            atomic_write_model(output_path, output)
            synchronize_asset(self._db(), self.assets_path, asset_id)

    def load_segments(self, asset_id: str) -> list[MediaSegment]:
        rows = (
            self._db()
            .execute(
                "SELECT * FROM timeline_segments WHERE asset_id = ? ORDER BY position",
                (asset_id,),
            )
            .fetchall()
        )
        segments: list[MediaSegment] = []
        for row in rows:
            segment_id = row["segment_id"]
            values = dict(row)
            values.pop("position")
            values.update(
                key_frame_paths=self._relation_values(
                    "segment_frames",
                    "relative_path",
                    "segment_id",
                    segment_id,
                    "position",
                ),
                tags=self._relation_values(
                    "segment_tags", "tag_name", "segment_id", segment_id, "tag_name"
                ),
                marker_ids=self._relation_values(
                    "segment_markers",
                    "marker_id",
                    "segment_id",
                    segment_id,
                    "marker_id",
                ),
            )
            segments.append(MediaSegment.model_validate(values))
        return segments

    def save_analysis_job(self, job: AnalysisJob) -> None:
        values = job.model_dump(mode="json", exclude={"marker_ids", "capabilities"})
        with self._lock, self._db():
            self._upsert_runtime_model("analysis_jobs", values, transaction=False)
            self._db().execute(
                "DELETE FROM analysis_job_markers WHERE job_id = ?", (job.job_id,)
            )
            self._db().execute(
                "DELETE FROM analysis_job_capabilities WHERE job_id = ?", (job.job_id,)
            )
            self._db().executemany(
                "INSERT INTO analysis_job_markers(job_id, marker_id) VALUES (?, ?)",
                [(job.job_id, value) for value in dict.fromkeys(job.marker_ids)],
            )
            self._db().executemany(
                "INSERT INTO analysis_job_capabilities(job_id, capability) VALUES (?, ?)",
                [
                    (job.job_id, value.value)
                    for value in dict.fromkeys(job.capabilities)
                ],
            )

    @property
    def agent_checkpoint_database_path(self) -> Path:
        return self.library_path / AGENT_CHECKPOINT_DATABASE_FILE_NAME

    def save_agent_job(self, job: AgentJob) -> None:
        self._validate_identifier(job.job_id, "agent")
        self._upsert_runtime_model("agent_jobs", job.model_dump(mode="json"))

    def load_agent_job(self, job_id: str) -> AgentJob | None:
        self._validate_identifier(job_id, "agent")
        row = (
            self._db()
            .execute("SELECT * FROM agent_jobs WHERE job_id = ?", (job_id,))
            .fetchone()
        )
        return _agent_job_from_row(row) if row else None

    def load_agent_jobs(self, asset_id: str | None = None) -> list[AgentJob]:
        if asset_id is None:
            rows = (
                self._db()
                .execute("SELECT * FROM agent_jobs ORDER BY created_at DESC")
                .fetchall()
            )
        else:
            self._validate_asset_id(asset_id)
            rows = (
                self._db()
                .execute(
                    "SELECT * FROM agent_jobs WHERE asset_id = ? ORDER BY created_at DESC",
                    (asset_id,),
                )
                .fetchall()
            )
        return [_agent_job_from_row(row) for row in rows]

    def load_analysis_jobs(self) -> list[AnalysisJob]:
        rows = (
            self._db()
            .execute("SELECT * FROM analysis_jobs ORDER BY created_at")
            .fetchall()
        )
        jobs: list[AnalysisJob] = []
        for row in rows:
            values = dict(row)
            values["strategy"] = json.loads(values["strategy"])
            values["marker_ids"] = self._relation_values(
                "analysis_job_markers",
                "marker_id",
                "job_id",
                row["job_id"],
                "marker_id",
            )
            values["capabilities"] = self._relation_values(
                "analysis_job_capabilities",
                "capability",
                "job_id",
                row["job_id"],
                "capability",
            )
            jobs.append(AnalysisJob.model_validate(values))
        return jobs

    def load_markers(self, asset_id: str) -> list[MediaMarker]:
        self._validate_asset_id(asset_id)
        rows = (
            self._db()
            .execute(
                "SELECT marker_id, asset_id, start_seconds, end_seconds, title, "
                "marker_range_before_seconds, marker_range_after_seconds FROM markers "
                "WHERE asset_id = ? ORDER BY start_seconds",
                (asset_id,),
            )
            .fetchall()
        )
        return [
            MediaMarker(
                **dict(row),
                tags=self._relation_values(
                    "marker_tags", "tag_name", "marker_id", row["marker_id"], "tag_name"
                ),
            )
            for row in rows
        ]

    def create_marker(self, marker: MediaMarker) -> MediaMarker:
        self._validate_identifier(marker.marker_id, "marker")
        if self.get(marker.asset_id) is None:
            raise ValueError("标记对应的素材不存在")
        markers = self.load_markers(marker.asset_id)
        if any(item.marker_id == marker.marker_id for item in markers):
            raise sqlite3.IntegrityError("标记标识已存在")
        markers.append(marker)
        self._write_markers(marker.asset_id, markers)
        return marker.model_copy(deep=True)

    def update_marker(
        self,
        asset_id: str,
        marker_id: str,
        *,
        start_seconds: float,
        end_seconds: float | None,
        title: str,
        tags: list[str],
        marker_range_before_seconds: int | None,
        marker_range_after_seconds: int | None,
    ) -> MediaMarker | None:
        self._validate_identifier(marker_id, "marker")
        markers = self.load_markers(asset_id)
        marker = next((item for item in markers if item.marker_id == marker_id), None)
        if marker is None:
            return None
        updated = MediaMarker.model_validate(
            {
                **marker.model_dump(),
                "start_seconds": start_seconds,
                "end_seconds": end_seconds,
                "title": title,
                "tags": tags,
                "marker_range_before_seconds": marker_range_before_seconds,
                "marker_range_after_seconds": marker_range_after_seconds,
            }
        )
        self._write_markers(
            asset_id,
            [updated if item.marker_id == marker_id else item for item in markers],
        )
        return updated

    def replace_markers_and_segments(
        self,
        asset_id: str,
        markers: list[MediaMarker],
        segments: list[MediaSegment],
    ) -> None:
        """审批批次同时改写标记和事件引用，任一步失败都恢复原业务文件。"""
        self._validate_asset_id(asset_id)
        if any(marker.asset_id != asset_id for marker in markers):
            raise ValueError("标记不属于同一个媒体素材")
        if any(segment.asset_id != asset_id for segment in segments):
            raise ValueError("时间轴事件不属于同一个媒体素材")
        original_markers = self.load_markers(asset_id)
        original_segments = self.load_segments(asset_id)
        marker_path = self.asset_directory(asset_id) / MARKERS_FILE_NAME
        timeline_path = self.artifacts_directory(asset_id) / TIMELINE_FILE_NAME
        with self._lock:
            try:
                atomic_write_model(
                    marker_path,
                    MarkersFile(asset_id=asset_id, markers=markers),
                )
                atomic_write_model(
                    timeline_path,
                    TimelineFile(asset_id=asset_id, segments=segments),
                )
                synchronize_asset(self._db(), self.assets_path, asset_id)
            except Exception:
                atomic_write_model(
                    marker_path,
                    MarkersFile(asset_id=asset_id, markers=original_markers),
                )
                atomic_write_model(
                    timeline_path,
                    TimelineFile(asset_id=asset_id, segments=original_segments),
                )
                synchronize_asset(self._db(), self.assets_path, asset_id)
                raise

    def delete_marker(self, asset_id: str, marker_id: str) -> bool:
        self._validate_identifier(marker_id, "marker")
        markers = self.load_markers(asset_id)
        remaining = [item for item in markers if item.marker_id != marker_id]
        if len(remaining) == len(markers):
            return False
        segments = self.load_segments(asset_id)
        if any(marker_id in segment.marker_ids for segment in segments):
            raise sqlite3.IntegrityError("标记仍被时间轴引用")
        self._write_markers(asset_id, remaining)
        return True

    def create_summary_documents(
        self, documents: list[SummaryDocument]
    ) -> list[SummaryDocument]:
        if not documents:
            return []
        asset_ids = {document.asset_id for document in documents}
        if len(asset_ids) != 1:
            raise ValueError("总结文档必须属于同一个素材")
        for document in documents:
            self._validate_identifier(document.document_id, "document")
        asset_id = next(iter(asset_ids))
        synchronize_asset(self._db(), self.assets_path, asset_id)
        loaded = {
            item.document_id: item for item in self.load_summary_documents(asset_id)
        }
        if any(document.document_id not in loaded for document in documents):
            raise ValueError("总结 manifest 未包含全部新文档")
        return [loaded[document.document_id] for document in documents]

    def load_summary_document(self, document_id: str) -> SummaryDocument | None:
        self._validate_identifier(document_id, "document")
        row = (
            self._db()
            .execute(
                "SELECT * FROM summary_documents WHERE document_id = ?", (document_id,)
            )
            .fetchone()
        )
        return self._summary_document_from_row(row) if row else None

    def load_summary_documents(self, asset_id: str) -> list[SummaryDocument]:
        self._validate_asset_id(asset_id)
        rows = (
            self._db()
            .execute(
                "SELECT * FROM summary_documents WHERE asset_id = ? "
                "ORDER BY parent_document_id IS NOT NULL, position, created_at",
                (asset_id,),
            )
            .fetchall()
        )
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
        document = self.load_summary_document(document_id)
        if document is None:
            return None
        synchronize_asset(self._db(), self.assets_path, document.asset_id)
        updated = self.load_summary_document(document_id)
        if updated is None or updated.revision != expected_revision + 1:
            return None
        return updated

    def reorder_summary_documents(
        self, parent_document_id: str, document_ids: list[str]
    ) -> None:
        parent = self.load_summary_document(parent_document_id)
        if parent is None:
            raise ValueError("主文档不存在")
        synchronize_asset(self._db(), self.assets_path, parent.asset_id)
        indexed_ids = [
            document.document_id
            for document in self.load_summary_documents(parent.asset_id)
            if document.parent_document_id == parent_document_id
        ]
        if indexed_ids != document_ids:
            raise ValueError("总结 manifest 排序与请求不一致")

    def delete_summary_document(self, document_id: str) -> bool:
        document = self.load_summary_document(document_id)
        if document is None:
            return False
        synchronize_asset(self._db(), self.assets_path, document.asset_id)
        return self.load_summary_document(document_id) is None

    def save_summary_conversation(self, conversation: SummaryConversation) -> None:
        self._validate_identifier(conversation.conversation_id, "conversation")
        record = SummaryConversationFile(conversation=conversation)
        path = conversation_file_path(
            self.asset_directory(conversation.asset_id), conversation.conversation_id
        )
        with self._lock:
            atomic_write_model(path, record)
            synchronize_asset(self._db(), self.assets_path, conversation.asset_id)

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
        self, conversation_id: str, title: str, updated_at: datetime
    ) -> SummaryConversation | None:
        conversation = self.load_summary_conversation_by_id(conversation_id)
        if conversation is None:
            return None
        record = self._load_conversation_file(conversation)
        updated = conversation.model_copy(
            update={"title": title, "updated_at": updated_at}
        )
        self._write_conversation_file(
            record.model_copy(update={"conversation": updated})
        )
        return updated

    def delete_summary_conversation(self, conversation_id: str) -> bool:
        conversation = self.load_summary_conversation_by_id(conversation_id)
        if conversation is None:
            return False
        path = conversation_file_path(
            self.asset_directory(conversation.asset_id), conversation_id
        )
        with self._lock:
            path.unlink(missing_ok=True)
            synchronize_asset(self._db(), self.assets_path, conversation.asset_id)
        return True

    def save_summary_message(self, message: SummaryMessage) -> None:
        self._validate_identifier(message.message_id, "message")
        conversation = self.load_summary_conversation_by_id(message.conversation_id)
        if conversation is None:
            raise ValueError("总结对话不存在")
        record = self._load_conversation_file(conversation)
        if any(item.message_id == message.message_id for item in record.messages):
            raise sqlite3.IntegrityError("消息标识已存在")
        updated_conversation = conversation.model_copy(
            update={"updated_at": message.created_at}
        )
        self._write_conversation_file(
            record.model_copy(
                update={
                    "conversation": updated_conversation,
                    "messages": [*record.messages, message],
                }
            )
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
        conversation = self.load_summary_conversation_by_id(proposal.conversation_id)
        if conversation is None:
            raise ValueError("总结对话不存在")
        record = self._load_conversation_file(conversation)
        proposals = [
            proposal if item.proposal_id == proposal.proposal_id else item
            for item in record.proposals
        ]
        if not any(
            item.proposal_id == proposal.proposal_id for item in record.proposals
        ):
            proposals.append(proposal)
        self._write_conversation_file(
            record.model_copy(update={"proposals": proposals})
        )

    def load_summary_proposal(self, proposal_id: str) -> SummaryEditProposal | None:
        self._validate_identifier(proposal_id, "proposal")
        row = (
            self._db()
            .execute(
                "SELECT * FROM summary_proposals WHERE proposal_id = ?", (proposal_id,)
            )
            .fetchone()
        )
        if row is None:
            return None
        values = dict(row)
        values["suggested_subdocuments"] = json.loads(values["suggested_subdocuments"])
        values["media_suggestions"] = json.loads(values["media_suggestions"])
        return SummaryEditProposal.model_validate(values)

    def load_summary_proposals(self, conversation_id: str) -> list[SummaryEditProposal]:
        rows = (
            self._db()
            .execute(
                "SELECT proposal_id FROM summary_proposals WHERE conversation_id = ? "
                "ORDER BY created_at",
                (conversation_id,),
            )
            .fetchall()
        )
        return [
            proposal
            for row in rows
            if (proposal := self.load_summary_proposal(row["proposal_id"])) is not None
        ]

    def save_summary_agent_run(self, run: SummaryAgentRun) -> None:
        self._validate_identifier(run.run_id, "run")
        self._upsert_runtime_model("summary_agent_runs", run.model_dump(mode="json"))

    def load_summary_agent_run(self, run_id: str) -> SummaryAgentRun | None:
        self._validate_identifier(run_id, "run")
        row = (
            self._db()
            .execute("SELECT * FROM summary_agent_runs WHERE run_id = ?", (run_id,))
            .fetchone()
        )
        return SummaryAgentRun.model_validate(dict(row)) if row else None

    def load_summary_agent_runs(self) -> list[SummaryAgentRun]:
        rows = (
            self._db()
            .execute("SELECT * FROM summary_agent_runs ORDER BY created_at")
            .fetchall()
        )
        return [SummaryAgentRun.model_validate(dict(row)) for row in rows]

    def save_agent_session(self, session: AgentSession) -> None:
        self._validate_identifier(session.session_id, "session")
        self._upsert_runtime_model("agent_sessions", session.model_dump(mode="json"))

    def load_agent_session(self, session_id: str) -> AgentSession | None:
        self._validate_identifier(session_id, "session")
        row = (
            self._db()
            .execute("SELECT * FROM agent_sessions WHERE session_id = ?", (session_id,))
            .fetchone()
        )
        return AgentSession.model_validate(dict(row)) if row else None

    def save_summary_agent_session(
        self, session: AgentSession, asset_id: str, root_document_id: str
    ) -> None:
        self.save_agent_session(session)
        with self._lock, self._db():
            self._db().execute(
                "INSERT INTO summary_agent_sessions(session_id, asset_id, root_document_id) "
                "VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET "
                "asset_id=excluded.asset_id, root_document_id=excluded.root_document_id",
                (session.session_id, asset_id, root_document_id),
            )

    def load_summary_agent_sessions(self, asset_id: str) -> list[AgentSession]:
        self._validate_asset_id(asset_id)
        rows = (
            self._db()
            .execute(
                "SELECT sessions.* FROM agent_sessions AS sessions "
                "JOIN summary_agent_sessions AS summary "
                "ON summary.session_id = sessions.session_id "
                "WHERE summary.asset_id = ? ORDER BY sessions.updated_at DESC",
                (asset_id,),
            )
            .fetchall()
        )
        return [AgentSession.model_validate(dict(row)) for row in rows]

    def load_summary_agent_session_binding(
        self, session_id: str
    ) -> tuple[str, str] | None:
        self._validate_identifier(session_id, "session")
        row = (
            self._db()
            .execute(
                "SELECT asset_id, root_document_id FROM summary_agent_sessions "
                "WHERE session_id = ?",
                (session_id,),
            )
            .fetchone()
        )
        return (row["asset_id"], row["root_document_id"]) if row else None

    def save_marker_agent_session(self, session: AgentSession, asset_id: str) -> None:
        self.save_agent_session(session)
        with self._lock, self._db():
            self._db().execute(
                "INSERT INTO marker_agent_sessions(session_id, asset_id) VALUES (?, ?) "
                "ON CONFLICT(session_id) DO UPDATE SET asset_id=excluded.asset_id",
                (session.session_id, asset_id),
            )

    def load_marker_agent_sessions(self, asset_id: str) -> list[AgentSession]:
        self._validate_asset_id(asset_id)
        rows = (
            self._db()
            .execute(
                "SELECT sessions.* FROM agent_sessions AS sessions "
                "JOIN marker_agent_sessions AS marker_agent "
                "ON marker_agent.session_id = sessions.session_id "
                "WHERE marker_agent.asset_id = ? ORDER BY sessions.updated_at DESC",
                (asset_id,),
            )
            .fetchall()
        )
        return [AgentSession.model_validate(dict(row)) for row in rows]

    def load_marker_agent_session_binding(self, session_id: str) -> str | None:
        self._validate_identifier(session_id, "session")
        row = (
            self._db()
            .execute(
                "SELECT asset_id FROM marker_agent_sessions WHERE session_id = ?",
                (session_id,),
            )
            .fetchone()
        )
        return row["asset_id"] if row else None

    def delete_agent_session(self, session_id: str) -> bool:
        self._validate_identifier(session_id, "session")
        with self._lock, self._db():
            cursor = self._db().execute(
                "DELETE FROM agent_sessions WHERE session_id = ?", (session_id,)
            )
        return cursor.rowcount > 0

    def save_agent_run(self, run: AgentRun) -> None:
        self._validate_identifier(run.run_id, "run")
        self._upsert_runtime_model("agent_runs", run.model_dump(mode="json"))

    def load_agent_run(self, run_id: str) -> AgentRun | None:
        self._validate_identifier(run_id, "run")
        row = (
            self._db()
            .execute("SELECT * FROM agent_runs WHERE run_id = ?", (run_id,))
            .fetchone()
        )
        return AgentRun.model_validate(dict(row)) if row else None

    def load_agent_runs(self) -> list[AgentRun]:
        rows = (
            self._db()
            .execute("SELECT * FROM agent_runs ORDER BY created_at")
            .fetchall()
        )
        return [AgentRun.model_validate(dict(row)) for row in rows]

    def append_agent_event(
        self,
        session_id: str,
        run_id: str | None,
        event_type: AgentEventType,
        payload: dict[str, object],
    ) -> AgentEvent:
        self._validate_identifier(session_id, "session")
        if run_id is not None:
            self._validate_identifier(run_id, "run")
        with self._lock, self._db():
            sequence = (
                self._db()
                .execute(
                    "SELECT COALESCE(MAX(sequence), 0) + 1 FROM agent_events "
                    "WHERE session_id = ?",
                    (session_id,),
                )
                .fetchone()[0]
            )
            event = AgentEvent(
                event_id=f"event-{uuid7().hex}",
                session_id=session_id,
                sequence=sequence,
                run_id=run_id,
                event_type=event_type,
                payload=payload,
            )
            values = event.model_dump(mode="json")
            values["payload"] = json.dumps(values["payload"], ensure_ascii=False)
            columns = tuple(values)
            self._db().execute(
                f"INSERT INTO agent_events ({', '.join(columns)}) "
                f"VALUES ({', '.join('?' for _ in columns)})",
                tuple(values[column] for column in columns),
            )
            self._db().execute(
                "UPDATE agent_sessions SET updated_at = ? WHERE session_id = ?",
                (event.created_at.isoformat(), session_id),
            )
        return event

    def load_agent_events(
        self, session_id: str, *, after_sequence: int = 0
    ) -> list[AgentEvent]:
        self._validate_identifier(session_id, "session")
        rows = (
            self._db()
            .execute(
                "SELECT * FROM agent_events WHERE session_id = ? AND sequence > ? "
                "ORDER BY sequence",
                (session_id, after_sequence),
            )
            .fetchall()
        )
        events: list[AgentEvent] = []
        for row in rows:
            values = dict(row)
            values["payload"] = json.loads(values["payload"])
            events.append(AgentEvent.model_validate(values))
        return events

    def interrupt_agent_runs(self) -> None:
        now = datetime.now(UTC)
        active_stages = (AgentRunStage.PENDING.value, AgentRunStage.RUNNING.value)
        rows = (
            self._db()
            .execute("SELECT * FROM agent_runs WHERE stage IN (?, ?)", active_stages)
            .fetchall()
        )
        for row in rows:
            run = AgentRun.model_validate(dict(row)).model_copy(
                update={
                    "stage": AgentRunStage.INTERRUPTED,
                    "error_message": "应用重启中断了 Agent 运行",
                    "updated_at": now,
                }
            )
            self.save_agent_run(run)
            self.append_agent_event(
                run.session_id,
                run.run_id,
                AgentEventType.TURN_END,
                {"stage": AgentRunStage.INTERRUPTED.value},
            )

    def save_agent_summary_proposal(self, proposal: SummaryEditProposal) -> None:
        self._validate_identifier(proposal.proposal_id, "proposal")
        self._validate_identifier(proposal.session_id, "session")
        values = proposal.model_dump(mode="json")
        values["suggested_subdocuments"] = json.dumps(
            values["suggested_subdocuments"], ensure_ascii=False
        )
        values["media_suggestions"] = json.dumps(
            values["media_suggestions"], ensure_ascii=False
        )
        self._upsert_runtime_model("summary_agent_proposals", values)

    def load_agent_summary_proposal(
        self, proposal_id: str
    ) -> SummaryEditProposal | None:
        self._validate_identifier(proposal_id, "proposal")
        row = (
            self._db()
            .execute(
                "SELECT * FROM summary_agent_proposals WHERE proposal_id = ?",
                (proposal_id,),
            )
            .fetchone()
        )
        if row is None:
            return None
        values = dict(row)
        values["suggested_subdocuments"] = json.loads(values["suggested_subdocuments"])
        values["media_suggestions"] = json.loads(values["media_suggestions"])
        return SummaryEditProposal.model_validate(values)

    def load_agent_summary_proposals(
        self, session_id: str
    ) -> list[SummaryEditProposal]:
        self._validate_identifier(session_id, "session")
        rows = (
            self._db()
            .execute(
                "SELECT proposal_id FROM summary_agent_proposals "
                "WHERE session_id = ? ORDER BY created_at",
                (session_id,),
            )
            .fetchall()
        )
        return [
            proposal
            for row in rows
            if (proposal := self.load_agent_summary_proposal(row["proposal_id"]))
            is not None
        ]

    def save_marker_proposal(self, proposal: MarkerProposal) -> None:
        self._validate_identifier(proposal.proposal_id, "proposal")
        self._validate_identifier(proposal.session_id, "session")
        values = proposal.model_dump(mode="json")
        values["changes"] = json.dumps(values["changes"], ensure_ascii=False)
        self._upsert_runtime_model("marker_agent_proposals", values)

    def load_marker_proposal(self, proposal_id: str) -> MarkerProposal | None:
        self._validate_identifier(proposal_id, "proposal")
        row = (
            self._db()
            .execute(
                "SELECT * FROM marker_agent_proposals WHERE proposal_id = ?",
                (proposal_id,),
            )
            .fetchone()
        )
        if row is None:
            return None
        values = dict(row)
        values["changes"] = json.loads(values["changes"])
        return MarkerProposal.model_validate(values)

    def load_marker_proposals(self, session_id: str) -> list[MarkerProposal]:
        self._validate_identifier(session_id, "session")
        rows = (
            self._db()
            .execute(
                "SELECT proposal_id FROM marker_agent_proposals "
                "WHERE session_id = ? ORDER BY created_at",
                (session_id,),
            )
            .fetchall()
        )
        return [
            proposal
            for row in rows
            if (proposal := self.load_marker_proposal(row["proposal_id"])) is not None
        ]

    def save_summary_media(self, media: SummaryMediaArtifact) -> None:
        self._validate_identifier(media.media_id, "media")
        asset_directory = self.asset_directory(media.asset_id)
        manifest = load_manifest(asset_directory)
        if any(item.media_id == media.media_id for item in manifest.media):
            raise sqlite3.IntegrityError("总结媒体标识已存在")
        write_manifest(
            asset_directory,
            manifest.model_copy(update={"media": [*manifest.media, media]}),
        )
        synchronize_asset(self._db(), self.assets_path, media.asset_id)

    def load_summary_media(self, asset_id: str) -> list[SummaryMediaArtifact]:
        rows = (
            self._db()
            .execute(
                "SELECT * FROM summary_media WHERE asset_id = ? ORDER BY created_at",
                (asset_id,),
            )
            .fetchall()
        )
        return [SummaryMediaArtifact.model_validate(dict(row)) for row in rows]

    def _write_asset_metadata(self, asset: MediaAsset) -> None:
        asset_directory = self.asset_directory(asset.asset_id)
        asset_directory.mkdir(parents=True, exist_ok=True)
        metadata = metadata_from_asset(
            asset,
            self.load_transcription_metadata(asset.asset_id),
            transcript_exists=self._transcript_path(asset.asset_id).is_file(),
        )
        atomic_write_model(asset_directory / ASSET_METADATA_FILE_NAME, metadata)

    def _write_markers(self, asset_id: str, markers: list[MediaMarker]) -> None:
        output = MarkersFile(asset_id=asset_id, markers=markers)
        with self._lock:
            atomic_write_model(
                self.asset_directory(asset_id) / MARKERS_FILE_NAME, output
            )
            synchronize_asset(self._db(), self.assets_path, asset_id)

    def _write_conversation_file(self, record: SummaryConversationFile) -> None:
        conversation = record.conversation
        path = conversation_file_path(
            self.asset_directory(conversation.asset_id), conversation.conversation_id
        )
        with self._lock:
            atomic_write_model(path, record)
            synchronize_asset(self._db(), self.assets_path, conversation.asset_id)

    def _load_conversation_file(
        self, conversation: SummaryConversation
    ) -> SummaryConversationFile:
        path = conversation_file_path(
            self.asset_directory(conversation.asset_id), conversation.conversation_id
        )
        try:
            return SummaryConversationFile.model_validate_json(
                path.read_text(encoding="utf-8")
            )
        except (OSError, ValueError) as error:
            raise ValueError("总结对话文件无效") from error

    def _summary_document_from_row(self, row: sqlite3.Row) -> SummaryDocument:
        values = dict(row)
        markdown = read_markdown(
            self.asset_directory(values["asset_id"]), values["relative_path"]
        )
        return SummaryDocument.model_validate({**values, "markdown": markdown})

    def _storyboard_for(self, asset: MediaAsset) -> ThumbnailStoryboardResponse | None:
        if not self.resolve_asset_file(asset, asset.thumbnail_sprite_path):
            return None
        values = (
            asset.thumbnail_tile_width,
            asset.thumbnail_tile_height,
            asset.thumbnail_interval_seconds,
            asset.thumbnail_columns,
            asset.thumbnail_total_tiles,
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
        tiles = [
            ThumbnailStoryboardTile(start_time=item.start_time, x=item.x, y=item.y)
            for item in build_thumbnail_tiles(storyboard)
        ]
        return ThumbnailStoryboardResponse(
            url=SPRITE_ROUTE_TEMPLATE.format(asset_id=asset.asset_id),
            tile_width=storyboard.tile_width,
            tile_height=storyboard.tile_height,
            tiles=tiles,
        )

    def _recover_interrupted_downloads(self) -> None:
        now = datetime.now(UTC)
        terminal_stages = (DownloadStage.COMPLETE.value, DownloadStage.FAILED.value)
        with self._db():
            self._db().execute(
                "UPDATE download_jobs SET stage = ?, message = ?, error_message = ?, "
                "updated_at = ? WHERE stage NOT IN (?, ?)",
                (
                    DownloadStage.FAILED.value,
                    "下载失败",
                    "应用重启中断了下载任务",
                    now.isoformat(),
                    *terminal_stages,
                ),
            )
        interrupted = {
            MediaAssetStatus.PENDING,
            MediaAssetStatus.DOWNLOADING,
            MediaAssetStatus.PROCESSING,
        }
        for asset in self.list():
            if asset.status in interrupted:
                self.save(
                    asset.model_copy(
                        update={
                            "status": MediaAssetStatus.FAILED,
                            "error_message": "应用重启中断了下载任务",
                            "updated_at": now,
                        }
                    )
                )

    def _transcript_path(self, asset_id: str) -> Path:
        return (
            self.asset_directory(asset_id)
            / ARTIFACTS_DIRECTORY_NAME
            / TRANSCRIPT_FILE_NAME
        )

    def _load_optional_model(self, path: Path, model_type, asset_id: str):
        if not path.is_file() or path.is_symlink():
            return None
        try:
            model = model_type.model_validate_json(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return model if model.asset_id == asset_id else None

    def _upsert_runtime_model(
        self,
        table_name: str,
        values: dict[str, object],
        *,
        transaction: bool = True,
    ) -> None:
        columns = tuple(values)
        updates = ", ".join(f"{column}=excluded.{column}" for column in columns[1:])
        statement = (
            f"INSERT INTO {table_name} ({', '.join(columns)}) "
            f"VALUES ({', '.join('?' for _ in columns)}) "
            f"ON CONFLICT({columns[0]}) DO UPDATE SET {updates}"
        )
        parameters = tuple(_sqlite_value(values[column]) for column in columns)
        if transaction:
            with self._lock, self._db():
                self._db().execute(statement, parameters)
        else:
            self._db().execute(statement, parameters)

    def _relation_values(
        self,
        table_name: str,
        value_column: str,
        owner_column: str,
        owner_id: str,
        order_column: str,
    ) -> list[str]:
        rows = (
            self._db()
            .execute(
                f"SELECT {value_column} FROM {table_name} WHERE {owner_column} = ? "
                f"ORDER BY {order_column}",
                (owner_id,),
            )
            .fetchall()
        )
        return [row[0] for row in rows]

    def _db(self) -> sqlite3.Connection:
        if self._connection is None:
            raise RuntimeError("资料库未打开")
        return self._connection

    def _load_folder_manifest(self) -> dict[str, Folder]:
        if not self.folder_manifest_path.exists():
            manifest = FolderManifest()
            atomic_write_model(self.folder_manifest_path, manifest)
            return {}
        try:
            manifest = FolderManifest.model_validate_json(
                self.folder_manifest_path.read_text(encoding="utf-8")
            )
        except (OSError, ValueError) as error:
            raise InvalidLibraryError("资料库文件夹清单无效") from error
        if manifest.format_version != FolderManifest().format_version:
            raise InvalidLibraryError("资料库文件夹清单版本不受支持")
        folders = {folder.folder_id: folder for folder in manifest.folders}
        if len(folders) != len(manifest.folders):
            raise InvalidLibraryError("资料库文件夹标识重复")
        sibling_names: set[tuple[str | None, str]] = set()
        for folder in manifest.folders:
            self._validate_folder_id(folder.folder_id)
            key = (folder.parent_id, folder.name.casefold())
            if key in sibling_names:
                raise InvalidLibraryError("同一父目录下存在重名文件夹")
            sibling_names.add(key)
        for folder in manifest.folders:
            expected_path = self._expected_folder_path(folder, folders, set())
            if folder.materialized_path != expected_path:
                raise InvalidLibraryError("资料库文件夹路径无效")
        return folders

    def _expected_folder_path(
        self,
        folder: Folder,
        folders: dict[str, Folder],
        visited: set[str],
    ) -> str:
        if folder.folder_id in visited:
            raise InvalidLibraryError("资料库文件夹存在循环引用")
        if folder.parent_id is None:
            return f"/{folder.folder_id}/"
        parent = folders.get(folder.parent_id)
        if parent is None:
            raise InvalidLibraryError("资料库文件夹引用了不存在的父目录")
        parent_path = self._expected_folder_path(
            parent,
            folders,
            {*visited, folder.folder_id},
        )
        return f"{parent_path}{folder.folder_id}/"

    def _write_folder_manifest(self) -> None:
        ordered_folders = sorted(
            self._folders.values(), key=lambda item: item.materialized_path
        )
        atomic_write_model(
            self.folder_manifest_path,
            FolderManifest(folders=ordered_folders),
        )

    def _require_folder(self, folder_id: str | None) -> Folder:
        if folder_id is None:
            raise FolderNotFoundError("文件夹不存在")
        self._validate_folder_id(folder_id)
        folder = self._folders.get(folder_id)
        if folder is None:
            raise FolderNotFoundError("文件夹不存在")
        return folder

    def _ensure_unique_folder_name(
        self,
        name: str,
        parent_id: str | None,
        *,
        exclude_id: str | None = None,
    ) -> None:
        normalized = name.casefold()
        if any(
            folder.folder_id != exclude_id
            and folder.parent_id == parent_id
            and folder.name.casefold() == normalized
            for folder in self._folders.values()
        ):
            raise FolderConflictError("同一父目录下不能创建重名文件夹")

    def _folder_response(self, folder_id: str) -> FolderResponse:
        response = next(
            (folder for folder in self.list_folders() if folder.folder_id == folder_id),
            None,
        )
        if response is None:
            raise FolderNotFoundError("文件夹不存在")
        return response

    @staticmethod
    def _validate_identifier(identifier: str, prefix: str) -> None:
        expected_prefix = f"{prefix}-"
        suffix = identifier.removeprefix(expected_prefix)
        valid_hexadecimal = all(character in "0123456789abcdef" for character in suffix)
        if (
            not identifier.startswith(expected_prefix)
            or len(suffix) != HEX_IDENTIFIER_LENGTH
            or not valid_hexadecimal
        ):
            raise ValueError(f"{prefix} ID 无效")

    @staticmethod
    def _validate_asset_id(asset_id: str) -> None:
        if not is_uuid7(asset_id):
            raise ValueError("asset ID 无效")

    @staticmethod
    def _validate_folder_id(folder_id: str) -> None:
        prefix = "folder-"
        suffix = folder_id.removeprefix(prefix)
        try:
            parsed = UUID(hex=suffix)
        except (ValueError, AttributeError) as error:
            raise ValueError("folder ID 无效") from error
        if (
            not folder_id.startswith(prefix)
            or len(suffix) != HEX_IDENTIFIER_LENGTH
            or parsed.version != 7
        ):
            raise ValueError("folder ID 无效")


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
