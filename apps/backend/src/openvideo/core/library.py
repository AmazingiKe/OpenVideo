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

from openvideo.core.download_models import DownloadEvent, DownloadJob, DownloadStage
from openvideo.core.identifiers import is_uuid7, uuid7
from openvideo.core.folder_models import (
    Folder,
    FolderManifest,
    FolderResponse,
    folder_name_from_source_title,
)
from openvideo.core.library_files import (
    ARTIFACTS_DIRECTORY_NAME,
    ASSET_METADATA_FILE_NAME,
    MARKERS_FILE_NAME,
    TRANSCRIPT_FILE_NAME,
    IndexIssue,
    MarkersFile,
    atomic_write_model,
    metadata_from_asset,
)
from openvideo.core.library_index import (
    load_index_issues,
    open_index_database,
    remove_asset_projection,
    synchronize_asset,
    synchronize_folders,
)
from openvideo.core.library_analysis_storage import LibraryAnalysisStorageMixin
from openvideo.core.library_generated_storage import LibraryGeneratedStorageMixin
from openvideo.core.media_models import (
    MediaAsset,
    MediaAssetResponse,
    MediaAssetStatus,
    MediaMarker,
    SourcePlatform,
    ThumbnailStoryboardResponse,
    ThumbnailStoryboardTile,
)
from openvideo.core.summary_files import read_markdown
from openvideo.core.summary_models import SummaryDocument
from openvideo.core.thumbnails import ThumbnailStoryboard, build_thumbnail_tiles


FORMAT_VERSION = 2
MANIFEST_FILE_NAME = "library.json"
FOLDER_MANIFEST_FILE_NAME = "folders.json"
AGENT_CHECKPOINT_DATABASE_FILE_NAME = "agent_checkpoints.sqlite3"
LOCK_FILE_NAME = ".openvideo.lock"
PLAYBACK_ROUTE_TEMPLATE = "/api/media/assets/{asset_id}/stream"
SCRUB_PREVIEW_ROUTE_TEMPLATE = "/api/media/assets/{asset_id}/scrub-preview"
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


class MediaLibrary(LibraryAnalysisStorageMixin, LibraryGeneratedStorageMixin):
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
            self._remove_legacy_agent_files()
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

    def _remove_legacy_agent_files(self) -> None:
        """旧会话不是业务成果，统一运行时启用后必须避免再次被恢复。"""
        checkpoint = self.library_path / AGENT_CHECKPOINT_DATABASE_FILE_NAME
        checkpoint.unlink(missing_ok=True)
        for asset_directory in self.assets_path.iterdir():
            if asset_directory.is_symlink() or not asset_directory.is_dir():
                continue
            conversations = asset_directory / "summary" / "conversations"
            if conversations.is_symlink():
                conversations.unlink(missing_ok=True)
            elif conversations.is_dir():
                resolved = conversations.resolve()
                if self.assets_path.resolve() not in resolved.parents:
                    raise InvalidLibraryError("旧 Agent 会话目录超出资料库范围")
                shutil.rmtree(resolved)

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

    def create_or_get_root_folder(self, name: str) -> FolderResponse:
        """合集自动归档需要稳定复用同名顶层分类，避免每次下载产生重复目录。"""
        normalized_name = folder_name_from_source_title(name)
        with self._lock:
            existing = next(
                (
                    folder
                    for folder in self._folders.values()
                    if folder.parent_id is None
                    and folder.name.casefold() == normalized_name.casefold()
                ),
                None,
            )
            if existing is not None:
                return self._folder_response(existing.folder_id)
            return self.create_folder(normalized_name)

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

    def save_download_job(
        self,
        job: DownloadJob,
        event: DownloadEvent | None = None,
    ) -> None:
        if event is not None and event.job_id != job.job_id:
            raise ValueError("下载事件与任务不匹配")
        values = job.model_dump(mode="json")
        with self._lock, self._db():
            self._upsert_runtime_model("download_jobs", values, transaction=False)
            if event is not None:
                event_values = event.model_dump(mode="json")
                columns = tuple(event_values)
                self._db().execute(
                    f"INSERT INTO download_events ({', '.join(columns)}) "
                    f"VALUES ({', '.join('?' for _ in columns)})",
                    tuple(event_values[column] for column in columns),
                )

    def get_download_job(self, job_id: str) -> DownloadJob | None:
        row = (
            self._db()
            .execute("SELECT * FROM download_jobs WHERE job_id = ?", (job_id,))
            .fetchone()
        )
        return DownloadJob.model_validate(dict(row)) if row else None

    def list_download_jobs(self, limit: int | None = None) -> list[DownloadJob]:
        statement = "SELECT * FROM download_jobs ORDER BY created_at DESC, job_id DESC"
        parameters: tuple[int, ...] = ()
        if limit is not None:
            statement += " LIMIT ?"
            parameters = (limit,)
        rows = self._db().execute(statement, parameters).fetchall()
        return [DownloadJob.model_validate(dict(row)) for row in rows]

    def list_download_events(self, job_id: str) -> list[DownloadEvent]:
        self._validate_identifier(job_id, "job")
        rows = (
            self._db()
            .execute(
                "SELECT * FROM download_events WHERE job_id = ? "
                "ORDER BY created_at, event_id",
                (job_id,),
            )
            .fetchall()
        )
        return [DownloadEvent.model_validate(dict(row)) for row in rows]

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
            scrub_preview_url=(
                SCRUB_PREVIEW_ROUTE_TEMPLATE.format(asset_id=asset.asset_id)
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
        atomic_write_model(
            self.asset_directory(asset_id) / MARKERS_FILE_NAME,
            output,
        )

    def _summary_document_from_row(self, row: sqlite3.Row) -> SummaryDocument:
        values = dict(row)
        markdown = read_markdown(
            self.asset_directory(values["asset_id"]),
            values["version_id"],
            values["relative_path"],
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
        rows = (
            self._db()
            .execute(
                "SELECT * FROM download_jobs WHERE stage NOT IN (?, ?)",
                terminal_stages,
            )
            .fetchall()
        )
        for row in rows:
            job = DownloadJob.model_validate(dict(row)).model_copy(
                update={
                    "stage": DownloadStage.FAILED,
                    "message": "下载失败",
                    "error_message": "应用重启中断了下载任务",
                    "updated_at": now,
                }
            )
            self.save_download_job(job, DownloadEvent.capture(job))
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


def _insert_model(
    connection: sqlite3.Connection,
    table_name: str,
    values: dict[str, object],
) -> None:
    columns = tuple(values)
    connection.execute(
        f"INSERT INTO {table_name} ({', '.join(columns)}) "
        f"VALUES ({', '.join('?' for _ in columns)})",
        tuple(_sqlite_value(values[column]) for column in columns),
    )
