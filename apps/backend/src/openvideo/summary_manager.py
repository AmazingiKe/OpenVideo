from __future__ import annotations

import io
import json
import re
import shutil
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.library_index import synchronize_asset
from openvideo.core.summary_files import (
    SUMMARY_ASSETS_DIRECTORY_NAME,
    SUMMARY_DOCUMENT_MAX_DEPTH,
    SUMMARY_DIRECTORY_NAME,
    SUMMARY_MANIFEST_FILE_NAME,
    SUMMARY_OUTPUT_DIRECTORY_NAME,
    SummaryManifest,
    SummaryManifestOperation,
    atomic_write_bytes,
    atomic_write_text,
    build_summary_manifest,
    document_relative_path,
    load_summary_manifest,
    markdown_digest,
    project_from_manifest,
    resolve_summary_path,
    summary_document_depths,
    write_summary_manifest,
)
from openvideo.core.summary_models import (
    SummaryDocument,
    SummaryDocumentCreate,
    SummaryDocumentMove,
    SummaryDocumentUpdate,
    SummaryExportResult,
    SummaryMediaArtifact,
    SummaryMediaCreate,
    SummaryMediaProvenance,
    SummaryMediaType,
    SummaryProject,
)
from openvideo.settings import Settings
from openvideo.tools.summary_media import (
    GIF_DEFAULT_DURATION_SECONDS,
    SummaryMediaError,
    generate_summary_media,
)


EXPORT_FILE_NAME_TIME_FORMAT = "%Y%m%d-%H%M%S-%f"


class SummaryError(RuntimeError):
    """总结工作台请求无法在当前资料库状态下完成。"""


class SummaryNotFoundError(SummaryError):
    """请求引用的总结资源不存在或不属于当前视频。"""


class SummaryRevisionConflictError(SummaryError):
    """文档已被更新，调用方必须读取新版本后再决定如何合并。"""


class SummaryManager:
    """维护素材唯一的当前笔记、媒体与导出。"""

    def __init__(self, library: MediaLibrary, settings: Settings) -> None:
        self.library = library
        self.settings = settings

    def project(self, asset_id: str) -> SummaryProject | None:
        self._require_asset(asset_id)
        manifest_path = resolve_summary_path(
            self.library.asset_directory(asset_id),
            SUMMARY_MANIFEST_FILE_NAME,
        )
        if not manifest_path.is_file():
            return None
        return project_from_manifest(
            load_summary_manifest(self.library.asset_directory(asset_id))
        )

    def documents(
        self,
        asset_id: str,
    ) -> list[SummaryDocument]:
        self._require_asset(asset_id)
        if self.project(asset_id) is None:
            return []
        return self.library.load_summary_documents(asset_id)

    def initialize_document(
        self,
        asset_id: str,
        title: str | None = None,
    ) -> SummaryDocument:
        """首次打开总结页时建立持久草稿，使用户直接进入 Markdown 编辑器。"""

        with self.library._lock:
            asset = self._require_asset(asset_id)
            current_project = self.project(asset_id)
            if current_project is not None:
                return self._require_document(current_project.root_document_id)
            document = self._prepare_document(
                SummaryDocument(
                    document_id=f"document-{uuid7().hex}",
                    asset_id=asset_id,
                    title=title.strip() if title and title.strip() else asset.title,
                )
            )
            project = SummaryProject(
                asset_id=asset_id,
                root_document_id=document.document_id,
            )
            self._write_project(project, [document])
            self.library.create_summary_documents([document])
            return self._require_document(document.document_id)

    def create_child(
        self,
        parent_document_id: str,
        request: SummaryDocumentCreate,
    ) -> SummaryDocument:
        with self.library._lock:
            parent = self._require_document(parent_document_id)
            documents = self.documents(parent.asset_id)
            depths = summary_document_depths(documents)
            if depths[parent.document_id] >= SUMMARY_DOCUMENT_MAX_DEPTH:
                raise SummaryError("总结文档最多支持三级")
            if len(documents) >= 100:
                raise SummaryError("单个笔记最多包含 100 篇文档")
            children = [
                document
                for document in documents
                if document.parent_document_id == parent.document_id
            ]
            document = self._prepare_document(
                SummaryDocument(
                    document_id=f"document-{uuid7().hex}",
                    asset_id=parent.asset_id,
                    parent_document_id=parent.document_id,
                    title=request.title,
                    markdown=request.markdown,
                    position=len(children),
                )
            )
            updated_documents = [*documents, document]
            try:
                self._write_document(document)
                self._write_manifest(parent.asset_id, updated_documents)
            except Exception:
                self._document_path(document).unlink(missing_ok=True)
                raise
            self.library.create_summary_documents([document])
            return self._require_document(document.document_id)

    def duplicate_document(self, document_id: str) -> SummaryDocument:
        document = self._require_document(document_id)
        if document.parent_document_id is None:
            raise SummaryError("主文档不能复制")
        return self.create_child(
            document.parent_document_id,
            SummaryDocumentCreate(
                title=f"{document.title} 副本",
                markdown=document.markdown,
            ),
        )

    def update_document(
        self,
        document_id: str,
        request: SummaryDocumentUpdate,
    ) -> SummaryDocument:
        with self.library._lock:
            document = self._require_document(document_id)
            manifest = load_summary_manifest(
                self.library.asset_directory(document.asset_id)
            )
            if any(
                item.operation_id == request.operation_id
                for item in manifest.recent_operations
            ):
                return document
            if request.client_sequence <= manifest.client_sequences.get(
                request.client_id, 0
            ):
                return document
            markdown = (
                request.markdown if request.markdown is not None else document.markdown
            )
            updated = document.model_copy(
                update={
                    "title": request.title
                    if request.title is not None
                    else document.title,
                    "markdown": markdown,
                    "content_digest": markdown_digest(markdown),
                    "revision": document.revision + 1,
                    "updated_at": datetime.now(UTC),
                }
            )
            documents = [
                updated if item.document_id == document_id else item
                for item in self.documents(document.asset_id)
            ]
            if request.markdown is not None:
                self._write_document(updated)
            operation = SummaryManifestOperation(
                operation_id=request.operation_id,
                client_id=request.client_id,
                client_sequence=request.client_sequence,
                document_id=document_id,
                completed_at=datetime.now(UTC),
            )
            self._write_manifest(document.asset_id, documents, operation=operation)
            self.library.update_summary_documents([updated])
            return updated

    def apply_agent_edit(
        self,
        document_id: str,
        expected_revision: int,
        markdown: str,
        suggested_children: list[SummaryDocumentCreate],
    ) -> tuple[SummaryDocument, list[SummaryDocument]]:
        """把正文与新增子文档作为一次原子修改提交。"""

        with self.library._lock:
            document = self._require_document(document_id)
            if document.revision != expected_revision:
                raise SummaryRevisionConflictError("文档版本冲突，请重新加载后再保存")
            documents = self.documents(document.asset_id)
            now = datetime.now(UTC)
            updated = document
            markdown_changed = markdown != document.markdown
            if markdown_changed:
                updated = self._prepare_document(
                    document.model_copy(
                        update={
                            "markdown": markdown,
                            "revision": document.revision + 1,
                            "updated_at": now,
                        }
                    )
                )
            root_id = (
                updated.document_id
                if updated.parent_document_id is None
                else updated.parent_document_id
            )
            child_count = sum(item.parent_document_id == root_id for item in documents)
            children = [
                self._prepare_document(
                    SummaryDocument(
                        document_id=f"document-{uuid7().hex}",
                        asset_id=updated.asset_id,
                        parent_document_id=root_id,
                        title=request.title,
                        markdown=request.markdown,
                        position=child_count + position,
                    )
                )
                for position, request in enumerate(suggested_children)
            ]
            committed_documents = [
                updated if item.document_id == updated.document_id else item
                for item in documents
            ] + children
            asset_directory = self.library.asset_directory(updated.asset_id)
            manifest_path = resolve_summary_path(
                asset_directory, SUMMARY_MANIFEST_FILE_NAME
            )
            changed_paths = [manifest_path, self._document_path(updated)] + [
                self._document_path(child) for child in children
            ]
            snapshots = {
                path: path.read_bytes() if path.is_file() else None
                for path in changed_paths
            }
            try:
                if markdown_changed:
                    self._write_document(updated)
                for child in children:
                    self._write_document(child)
                manifest = load_summary_manifest(asset_directory)
                write_summary_manifest(
                    asset_directory,
                    build_summary_manifest(
                        self._next_project(manifest),
                        committed_documents,
                        manifest.media,
                    ),
                )
                synchronize_asset(
                    self.library._db(),
                    self.library.assets_path,
                    updated.asset_id,
                )
            except Exception:
                for path, content in snapshots.items():
                    if content is None:
                        path.unlink(missing_ok=True)
                    else:
                        atomic_write_bytes(path, content)
                synchronize_asset(
                    self.library._db(),
                    self.library.assets_path,
                    updated.asset_id,
                )
                raise
            committed = self._require_document(updated.document_id)
            committed_children = [
                self._require_document(child.document_id) for child in children
            ]
            return committed, committed_children

    def restore_agent_change(
        self,
        document_id: str,
        expected_revision: int,
        markdown: str,
        remove_document_ids: list[str],
        remove_media_ids: list[str],
        restored_revision: int | None = None,
    ) -> SummaryDocument:
        """撤销整个 Agent 修改；目标有后续修改时拒绝覆盖。"""

        with self.library._lock:
            document = self._require_document(document_id)
            if document.revision != expected_revision:
                raise SummaryRevisionConflictError("文档版本冲突，不能覆盖后续修改")
            documents = self.documents(document.asset_id)
            removable_documents = [
                item for item in documents if item.document_id in remove_document_ids
            ]
            if {item.document_id for item in removable_documents} != set(
                remove_document_ids
            ):
                raise SummaryRevisionConflictError("新增子文档已变化，不能整批撤销")
            manifest = load_summary_manifest(
                self.library.asset_directory(document.asset_id)
            )
            removable_media = [
                item for item in manifest.media if item.media_id in remove_media_ids
            ]
            if {item.media_id for item in removable_media} != set(remove_media_ids):
                raise SummaryRevisionConflictError("新增媒体已变化，不能整批撤销")
            restored = self._prepare_document(
                document.model_copy(
                    update={
                        "markdown": markdown,
                        "revision": restored_revision or document.revision + 1,
                        "updated_at": datetime.now(UTC),
                    }
                )
            )
            remaining_documents = [
                restored if item.document_id == restored.document_id else item
                for item in documents
                if item.document_id not in remove_document_ids
            ]
            remaining_media = [
                item for item in manifest.media if item.media_id not in remove_media_ids
            ]
            asset_directory = self.library.asset_directory(document.asset_id)
            manifest_path = resolve_summary_path(
                asset_directory, SUMMARY_MANIFEST_FILE_NAME
            )
            removed_paths = [
                self._document_path(item) for item in removable_documents
            ] + [self._artifact_path(item) for item in removable_media]
            changed_paths = [
                manifest_path,
                self._document_path(restored),
                *removed_paths,
            ]
            snapshots = {
                path: path.read_bytes() if path.is_file() else None
                for path in changed_paths
            }
            try:
                self._write_document(restored)
                write_summary_manifest(
                    asset_directory,
                    build_summary_manifest(
                        self._next_project(manifest),
                        remaining_documents,
                        remaining_media,
                    ),
                )
                for path in removed_paths:
                    path.unlink(missing_ok=True)
                synchronize_asset(
                    self.library._db(),
                    self.library.assets_path,
                    document.asset_id,
                )
            except Exception:
                for path, content in snapshots.items():
                    if content is None:
                        path.unlink(missing_ok=True)
                    else:
                        atomic_write_bytes(path, content)
                synchronize_asset(
                    self.library._db(),
                    self.library.assets_path,
                    document.asset_id,
                )
                raise
            return self._require_document(document.document_id)

    def move_document(
        self,
        document_id: str,
        request: SummaryDocumentMove,
    ) -> list[SummaryDocument]:
        with self.library._lock:
            document = self._require_document(document_id)
            if document.parent_document_id is None:
                raise SummaryError("主文档不能移动")
            parent = self._require_document(request.parent_document_id)
            if parent.asset_id != document.asset_id:
                raise SummaryError("目标父文档不属于当前笔记")
            documents = self.documents(document.asset_id)
            depths = summary_document_depths(documents)
            subtree_ids = _summary_subtree_ids(documents, document.document_id)
            if parent.document_id in subtree_ids:
                raise SummaryError("文档不能移动到自身或其子文档下")
            subtree_height = max(
                depths[item_id] - depths[document.document_id]
                for item_id in subtree_ids
            )
            if (
                depths[parent.document_id] + 1 + subtree_height
                > SUMMARY_DOCUMENT_MAX_DEPTH
            ):
                raise SummaryError("移动后文档树将超过三级")

            sibling_orders: dict[str, list[SummaryDocument]] = {}
            for parent_id in {document.parent_document_id, parent.document_id}:
                sibling_orders[parent_id] = sorted(
                    (
                        item
                        for item in documents
                        if item.parent_document_id == parent_id
                        and item.document_id != document.document_id
                    ),
                    key=lambda item: (item.position, item.created_at),
                )
            target_siblings = sibling_orders[parent.document_id]
            target_position = min(request.position, len(target_siblings))
            target_siblings.insert(target_position, document)

            placements: dict[str, tuple[str, int]] = {}
            for parent_id, siblings in sibling_orders.items():
                for position, sibling in enumerate(siblings):
                    placements[sibling.document_id] = (parent_id, position)
            now = datetime.now(UTC)
            moved_documents = []
            for item in documents:
                placement = placements.get(item.document_id)
                if placement is None:
                    moved_documents.append(item)
                    continue
                next_parent_id, next_position = placement
                changed = (
                    item.parent_document_id != next_parent_id
                    or item.position != next_position
                )
                moved_documents.append(
                    item.model_copy(
                        update={
                            "parent_document_id": next_parent_id,
                            "position": next_position,
                            "revision": item.revision + 1,
                            "updated_at": now,
                        }
                    )
                    if changed
                    else item
                )

            asset_directory = self.library.asset_directory(document.asset_id)
            manifest_path = resolve_summary_path(
                asset_directory, SUMMARY_MANIFEST_FILE_NAME
            )
            manifest_snapshot = manifest_path.read_bytes()
            changed_document_ids = {
                item.document_id
                for item, moved in zip(documents, moved_documents, strict=True)
                if item != moved
            }
            previous_placements = [
                item for item in documents if item.document_id in changed_document_ids
            ]
            next_placements = [
                item
                for item in moved_documents
                if item.document_id in changed_document_ids
            ]
            try:
                self._write_manifest(document.asset_id, moved_documents)
                self.library.update_summary_documents(next_placements)
            except Exception:
                atomic_write_bytes(manifest_path, manifest_snapshot)
                self.library.update_summary_documents(previous_placements)
                raise
            return self.documents(document.asset_id)

    def delete_document(self, document_id: str) -> None:
        with self.library._lock:
            document = self._require_document(document_id)
            if document.parent_document_id is None:
                raise ValueError("主文档不能单独删除")
            documents = self.documents(document.asset_id)
            removed_ids = _summary_subtree_ids(documents, document_id)
            manifest = load_summary_manifest(
                self.library.asset_directory(document.asset_id)
            )
            removed_documents = [
                item for item in documents if item.document_id in removed_ids
            ]
            removed_media = [
                item for item in manifest.media if item.document_id in removed_ids
            ]
            remaining_media = [
                item for item in manifest.media if item.document_id not in removed_ids
            ]
            remaining_documents = [
                item for item in documents if item.document_id not in removed_ids
            ]
            remaining_documents = _normalize_sibling_positions(
                remaining_documents,
                document.parent_document_id,
            )
            asset_directory = self.library.asset_directory(document.asset_id)
            manifest_path = resolve_summary_path(
                asset_directory, SUMMARY_MANIFEST_FILE_NAME
            )
            removed_paths = [
                self._document_path(item) for item in removed_documents
            ] + [
                resolve_summary_path(asset_directory, item.relative_path)
                for item in removed_media
            ]
            snapshots = {
                path: path.read_bytes() if path.is_file() else None
                for path in [manifest_path, *removed_paths]
            }
            try:
                write_summary_manifest(
                    asset_directory,
                    build_summary_manifest(
                        self._next_project(manifest),
                        remaining_documents,
                        remaining_media,
                    ),
                )
                for path in removed_paths:
                    path.unlink(missing_ok=True)
                synchronize_asset(
                    self.library._db(),
                    self.library.assets_path,
                    document.asset_id,
                )
            except Exception:
                for path, content in snapshots.items():
                    if content is None:
                        path.unlink(missing_ok=True)
                    else:
                        atomic_write_bytes(path, content)
                synchronize_asset(
                    self.library._db(),
                    self.library.assets_path,
                    document.asset_id,
                )
                raise

    def create_media(
        self,
        request: SummaryMediaCreate,
        provenance: SummaryMediaProvenance | None = None,
    ) -> tuple[SummaryMediaArtifact, SummaryDocument]:
        document = self._require_document(request.document_id)
        if document.revision != request.expected_revision:
            raise SummaryRevisionConflictError("文档版本冲突，请重新选择插入位置")
        asset = self._require_asset(document.asset_id)
        end_seconds = request.end_seconds
        if request.media_type == SummaryMediaType.GIF and end_seconds is None:
            end_seconds = request.start_seconds + GIF_DEFAULT_DURATION_SECONDS
        if request.start_seconds < 0 or (
            asset.duration_seconds is not None
            and request.start_seconds >= asset.duration_seconds
        ):
            raise SummaryError("媒体时间点超出视频范围")
        if (
            end_seconds is not None
            and asset.duration_seconds is not None
            and end_seconds > asset.duration_seconds
        ):
            raise SummaryError("媒体时间范围超出视频范围")
        playback = self.library.resolve_asset_file(asset, asset.playback_path)
        if playback is None:
            raise SummaryError("视频文件不存在")
        media_id = f"media-{uuid7().hex}"
        suffix = ".jpg" if request.media_type == SummaryMediaType.IMAGE else ".gif"
        media_path = f"{SUMMARY_ASSETS_DIRECTORY_NAME}/{media_id}{suffix}"
        relative_path = f"{SUMMARY_DIRECTORY_NAME}/{media_path}"
        output_path = resolve_summary_path(
            self.library.asset_directory(asset.asset_id),
            media_path,
        )
        try:
            generate_summary_media(
                playback,
                output_path,
                request.media_type,
                request.start_seconds,
                end_seconds,
                self.settings.ffmpeg_path,
                self.settings.ffmpeg_bin_dir,
            )
        except SummaryMediaError as error:
            raise SummaryError(str(error)) from error
        artifact = SummaryMediaArtifact(
            media_id=media_id,
            asset_id=asset.asset_id,
            document_id=document.document_id,
            media_type=request.media_type,
            relative_path=relative_path,
            caption=request.caption,
            start_seconds=request.start_seconds,
            end_seconds=end_seconds,
            **(provenance.model_dump() if provenance is not None else {}),
        )
        markdown_path = (
            f"assets/{media_id}{suffix}"
            if document.parent_document_id is None
            else f"../assets/{media_id}{suffix}"
        )
        updated_markdown = _insert_markdown(
            document.markdown,
            request.insert_after,
            f"![{request.caption}]({markdown_path})",
        )
        updated = self.update_document(
            document.document_id,
            SummaryDocumentUpdate(
                operation_id=f"summary-operation-{uuid7().hex}",
                client_id=f"summary-client-{uuid7().hex}",
                client_sequence=1,
                markdown=updated_markdown,
            ),
        )
        self.library.save_summary_media(artifact)
        return artifact, updated

    def export(
        self,
        asset_id: str,
    ) -> SummaryExportResult:
        asset = self._require_asset(asset_id)
        project = self.project(asset_id)
        if project is None:
            raise SummaryNotFoundError("请先生成笔记")
        documents = self.documents(asset_id)
        root = next(
            (document for document in documents if document.parent_document_id is None),
            None,
        )
        if root is None:
            raise SummaryNotFoundError("笔记缺少主文档")
        media = self.library.load_summary_media(asset_id)
        exported_at = datetime.now().astimezone()
        export_manifest = {
            "format_version": 3,
            "asset": {
                "asset_id": asset.asset_id,
                "title": asset.title,
                "source_url": asset.source_url,
                "source_platform": asset.source_platform.value,
            },
            "project": project.model_dump(mode="json"),
            "root_document_id": root.document_id,
            "documents": [
                document.model_dump(mode="json", exclude={"markdown"})
                for document in documents
            ],
            "media": [artifact.model_dump(mode="json") for artifact in media],
            "exported_at": exported_at.isoformat(timespec="milliseconds"),
        }
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for document in documents:
                archive.writestr(document.relative_path, document.markdown)
            for artifact in media:
                source = self._artifact_path(artifact)
                archive.write(source, f"assets/{source.name}")
            archive.writestr(
                SUMMARY_MANIFEST_FILE_NAME,
                json.dumps(export_manifest, ensure_ascii=False, indent=2),
            )
        export_id = f"export-{uuid7().hex}"
        timestamp = exported_at.strftime(EXPORT_FILE_NAME_TIME_FORMAT)[:-3]
        file_name = f"summary-{timestamp}-{export_id}.zip"
        output_directory = (
            self.library.asset_directory(asset_id) / SUMMARY_OUTPUT_DIRECTORY_NAME
        )
        if output_directory.is_symlink():
            raise SummaryError("总结导出目录不能是符号链接")
        output_path = output_directory / file_name
        content = buffer.getvalue()
        atomic_write_bytes(output_path, content)
        return SummaryExportResult(
            export_id=export_id,
            relative_path=output_path.relative_to(
                self.library.asset_directory(asset_id)
            ).as_posix(),
            file_name=file_name,
            size_bytes=len(content),
            exported_at=exported_at,
        )

    def media_path(self, media_id: str) -> Path:
        artifacts = [
            artifact
            for asset in self.library.list()
            for artifact in self.library.load_summary_media(asset.asset_id)
            if artifact.media_id == media_id
        ]
        if not artifacts:
            raise SummaryNotFoundError("总结媒体不存在")
        return self._artifact_path(artifacts[0])

    def _write_project(
        self,
        project: SummaryProject,
        documents: list[SummaryDocument],
    ) -> None:
        asset_directory = self.library.asset_directory(project.asset_id)
        target = resolve_summary_path(
            asset_directory, SUMMARY_MANIFEST_FILE_NAME
        ).parent
        temporary = target.with_name(f".{target.name}.creating")
        if temporary.exists() and not temporary.is_symlink():
            shutil.rmtree(temporary)
        temporary.mkdir(parents=True, exist_ok=False)
        try:
            for document in documents:
                path = temporary / document.relative_path
                atomic_write_text(path, document.markdown)
            manifest = build_summary_manifest(project, documents, [])
            atomic_write_text(
                temporary / SUMMARY_MANIFEST_FILE_NAME,
                manifest.model_dump_json(indent=2),
            )
            backup = target.with_name(f".{target.name}.replaced")
            if backup.exists() and not backup.is_symlink():
                shutil.rmtree(backup)
            if target.exists():
                target.replace(backup)
            temporary.replace(target)
            if backup.exists():
                shutil.rmtree(backup, ignore_errors=True)
        except Exception:
            backup = target.with_name(f".{target.name}.replaced")
            if not target.exists() and backup.exists():
                backup.replace(target)
            raise
        finally:
            if temporary.is_dir():
                shutil.rmtree(temporary)

    def _write_manifest(
        self,
        asset_id: str,
        documents: list[SummaryDocument],
        *,
        operation: SummaryManifestOperation | None = None,
    ) -> None:
        asset_directory = self.library.asset_directory(asset_id)
        manifest = load_summary_manifest(asset_directory)
        media = self.library.load_summary_media(asset_id)
        operations = manifest.recent_operations
        client_sequences = manifest.client_sequences
        if operation is not None:
            operations = [*operations, operation]
            client_sequences = {
                **client_sequences,
                operation.client_id: operation.client_sequence,
            }
        write_summary_manifest(
            asset_directory,
            build_summary_manifest(
                self._next_project(manifest),
                documents,
                media,
                recent_operations=operations,
                client_sequences=client_sequences,
            ),
        )

    @staticmethod
    def _next_project(manifest: SummaryManifest) -> SummaryProject:
        project = project_from_manifest(manifest)
        return project.model_copy(
            update={
                "revision": project.revision + 1,
                "updated_at": datetime.now(UTC),
            }
        )

    def _prepare_document(self, document: SummaryDocument) -> SummaryDocument:
        relative_path = document_relative_path(document)
        markdown = document.markdown.rstrip() + "\n" if document.markdown else ""
        return document.model_copy(
            update={
                "relative_path": relative_path,
                "markdown": markdown,
                "content_digest": markdown_digest(markdown),
            }
        )

    def _document_path(self, document: SummaryDocument) -> Path:
        return resolve_summary_path(
            self.library.asset_directory(document.asset_id),
            document.relative_path,
        )

    def _write_document(self, document: SummaryDocument) -> None:
        atomic_write_text(self._document_path(document), document.markdown)

    def _artifact_path(self, artifact: SummaryMediaArtifact) -> Path:
        path = self.library.asset_directory(artifact.asset_id) / artifact.relative_path
        resolved = path.resolve()
        asset_directory = self.library.asset_directory(artifact.asset_id).resolve()
        if (
            not resolved.is_relative_to(asset_directory)
            or not resolved.is_file()
            or resolved.is_symlink()
        ):
            raise SummaryNotFoundError("总结媒体不存在")
        return resolved

    def _require_asset(self, asset_id: str):
        asset = self.library.get(asset_id)
        if asset is None:
            raise SummaryNotFoundError("视频素材不存在")
        return asset

    def _require_document(self, document_id: str) -> SummaryDocument:
        document = self.library.load_summary_document(document_id)
        if document is None:
            raise SummaryNotFoundError("总结文档不存在")
        return document


def _summary_subtree_ids(
    documents: list[SummaryDocument],
    document_id: str,
) -> set[str]:
    descendants = {document_id}
    while True:
        next_ids = {
            document.document_id
            for document in documents
            if document.parent_document_id in descendants
        }
        unseen = next_ids - descendants
        if not unseen:
            return descendants
        descendants.update(unseen)


def _normalize_sibling_positions(
    documents: list[SummaryDocument],
    parent_document_id: str,
) -> list[SummaryDocument]:
    siblings = sorted(
        (
            document
            for document in documents
            if document.parent_document_id == parent_document_id
        ),
        key=lambda document: (document.position, document.created_at),
    )
    positions = {
        document.document_id: position for position, document in enumerate(siblings)
    }
    now = datetime.now(UTC)
    return [
        document.model_copy(
            update={
                "position": positions[document.document_id],
                "revision": document.revision + 1,
                "updated_at": now,
            }
        )
        if document.document_id in positions
        and document.position != positions[document.document_id]
        else document
        for document in documents
    ]


def _insert_markdown(markdown: str, insert_after: str | None, content: str) -> str:
    insertion = f"\n\n{content}\n"
    if insert_after is None:
        return markdown.rstrip() + insertion
    occurrences = [
        match.start() for match in re.finditer(re.escape(insert_after), markdown)
    ]
    if len(occurrences) != 1:
        raise SummaryError("媒体插入锚点必须在文档中唯一存在")
    index = occurrences[0] + len(insert_after)
    return markdown[:index] + insertion + markdown[index:]
