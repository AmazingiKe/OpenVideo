from __future__ import annotations

import hashlib
import io
import json
import os
import posixpath
import re
import shutil
import zipfile
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

import litellm
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from openvideo.core.event_analysis_models import EventAnalysisStatus
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.library_index import synchronize_asset
from openvideo.core.summary_files import (
    SUMMARY_ASSETS_DIRECTORY_NAME,
    SUMMARY_DIRECTORY_NAME,
    SUMMARY_MANIFEST_FILE_NAME,
    SUMMARY_OUTPUT_DIRECTORY_NAME,
    SummaryRootManifest,
    atomic_write_bytes,
    atomic_write_text,
    build_version_manifest,
    document_relative_path,
    load_root_manifest,
    load_version_manifest,
    markdown_digest,
    resolve_summary_path,
    resolve_version_path,
    version_relative_directory,
    write_root_manifest,
    write_version_manifest,
)
from openvideo.core.summary_models import (
    SummaryContextSummary,
    SummaryDetail,
    SummaryDocument,
    SummaryDocumentCreate,
    SummaryDocumentUpdate,
    SummaryExportResult,
    SummaryGenerationRequest,
    SummaryGenerationResult,
    SummaryMediaArtifact,
    SummaryMediaCreate,
    SummaryMediaType,
    SummaryVersion,
)
from openvideo.core.summary_presets import require_summary_preset
from openvideo.llm.capability_resolver import CapabilityResolver
from openvideo.settings import Settings
from openvideo.tools.llm import LlmCompletionError, complete_text
from openvideo.tools.summary_media import (
    GIF_DEFAULT_DURATION_SECONDS,
    SummaryMediaError,
    generate_summary_media,
)


SUMMARY_AGENT_TIMEOUT_SECONDS = 120
SUMMARY_PLAN_MAX_TOKENS = 2_000
SUMMARY_OUTPUT_TOKENS = {
    SummaryDetail.CONCISE: 4_000,
    SummaryDetail.STANDARD: 8_000,
    SummaryDetail.DETAILED: 12_000,
}
EXPORT_FILE_NAME_TIME_FORMAT = "%Y%m%d-%H%M%S-%f"


class SummaryError(RuntimeError):
    """总结工作台请求无法在当前资料库状态下完成。"""


class SummaryNotFoundError(SummaryError):
    """请求引用的总结资源不存在或不属于当前视频。"""


class SummaryRevisionConflictError(SummaryError):
    """文档已被更新，调用方必须读取新版本后再决定如何合并。"""


class SummaryCapacityError(SummaryError):
    """已知模型容量无法容纳完整上下文时阻止生成，绝不静默截断。"""

    def __init__(
        self,
        stage: str,
        required_tokens: int,
        context_tokens: int,
    ) -> None:
        super().__init__("所选模型无法容纳完整总结上下文")
        self.detail = {
            "code": "summary_context_capacity_exceeded",
            "message": str(self),
            "stage": stage,
            "required_tokens": required_tokens,
            "context_tokens": context_tokens,
        }


class SummaryPlanDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=200)
    parent_key: str | None = None


class SummaryPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    documents: list[SummaryPlanDocument] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def validate_tree(self) -> "SummaryPlan":
        keys = [document.key for document in self.documents]
        if len(keys) != len(set(keys)):
            raise ValueError("总结规划文档键不能重复")
        roots = [document for document in self.documents if document.parent_key is None]
        if len(roots) != 1:
            raise ValueError("总结规划必须只有一篇主文档")
        known = set(keys)
        if any(
            document.parent_key is not None and document.parent_key not in known
            for document in self.documents
        ):
            raise ValueError("总结规划引用了不存在的父文档")
        root_key = roots[0].key
        if any(
            document.parent_key not in {None, root_key}
            for document in self.documents
        ):
            raise ValueError("本期总结文档只支持主文档与一级子文档")
        return self


class SummaryGeneratedDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    relative_path: str
    markdown: str


class SummaryBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    documents: list[SummaryGeneratedDocument]


class SummaryManager:
    """维护多版本文档、媒体、导出与生成路径白名单。"""

    def __init__(self, library: MediaLibrary, settings: Settings) -> None:
        self.library = library
        self.settings = settings
        self.capability_resolver = CapabilityResolver()

    def versions(self, asset_id: str) -> list[SummaryVersion]:
        self._require_asset(asset_id)
        return self.library.load_summary_versions(asset_id)

    def current_version(self, asset_id: str) -> SummaryVersion | None:
        versions = self.versions(asset_id)
        if not versions:
            return None
        root = load_root_manifest(self.library.asset_directory(asset_id))
        return next(
            version
            for version in versions
            if version.version_id == root.current_version_id
        )

    def select_version(self, asset_id: str, version_id: str) -> SummaryVersion:
        version = self._require_version(asset_id, version_id)
        asset_directory = self.library.asset_directory(asset_id)
        root = load_root_manifest(asset_directory)
        write_root_manifest(
            asset_directory,
            root.model_copy(
                update={
                    "current_version_id": version_id,
                    "updated_at": datetime.now(UTC),
                }
            ),
        )
        return version

    def documents(
        self,
        asset_id: str,
        version_id: str | None = None,
    ) -> list[SummaryDocument]:
        self._require_asset(asset_id)
        resolved_version_id = version_id
        if resolved_version_id is None:
            version = self.current_version(asset_id)
            if version is None:
                return []
            resolved_version_id = version.version_id
        self._require_version(asset_id, resolved_version_id)
        return self.library.load_summary_documents(asset_id, resolved_version_id)

    def generate(
        self,
        asset_id: str,
        request: SummaryGenerationRequest,
    ) -> SummaryGenerationResult:
        asset = self._require_asset(asset_id)
        model = self.settings.ai_model(request.ai_model_id)
        if model is None:
            raise SummaryError("所选 AI 模型不存在")
        try:
            preset = require_summary_preset(request.preset_id)
        except ValueError as error:
            raise SummaryError(str(error)) from error
        context, context_summary = self._formal_context(asset_id)
        version_id = f"summary-version-{uuid7().hex}"
        version = SummaryVersion(
            version_id=version_id,
            asset_id=asset_id,
            preset_id=preset.preset_id,
            preset_version=preset.version,
            user_input=request.user_input.strip() if request.user_input else None,
            ai_model_id=request.ai_model_id,
            detail=request.detail,
            output_language=request.output_language,
            context_summary=context_summary,
            relative_path=version_relative_directory(version_id),
        )

        plan_messages = _plan_messages(
            asset.title,
            context,
            preset.prompt,
            request,
        )
        capacity_unknown = self._preflight(
            model,
            preset.minimum_context_tokens,
            "planning",
            plan_messages,
            SUMMARY_PLAN_MAX_TOKENS,
        )
        try:
            plan_content = complete_text(
                model,
                plan_messages,
                SUMMARY_AGENT_TIMEOUT_SECONDS,
                SUMMARY_PLAN_MAX_TOKENS,
                True,
            )
            plan = SummaryPlan.model_validate_json(_strip_code_fence(plan_content))
        except (LlmCompletionError, ValidationError, ValueError) as error:
            raise SummaryError(f"总结文档规划无效：{error}") from error

        allocated = _allocate_documents(asset_id, version_id, plan)
        allowed_paths = {
            document.relative_path: document for document in allocated
        }
        body_messages = _body_messages(
            asset.title,
            context,
            preset.prompt,
            request,
            version,
            allocated,
        )
        output_tokens = SUMMARY_OUTPUT_TOKENS[request.detail]
        capacity_unknown = (
            self._preflight(
                model,
                preset.minimum_context_tokens,
                "writing",
                body_messages,
                output_tokens,
            )
            or capacity_unknown
        )
        try:
            body_content = complete_text(
                model,
                body_messages,
                SUMMARY_AGENT_TIMEOUT_SECONDS,
                output_tokens,
                True,
            )
            body = SummaryBody.model_validate_json(_strip_code_fence(body_content))
        except (LlmCompletionError, ValidationError, ValueError) as error:
            raise SummaryError(f"总结正文输出无效：{error}") from error
        generated_paths = [document.relative_path for document in body.documents]
        if (
            len(generated_paths) != len(set(generated_paths))
            or set(generated_paths) != set(allowed_paths)
        ):
            raise SummaryError("总结正文只能写入后端预分配的完整路径表")
        markdown_by_path = {
            document.relative_path: document.markdown for document in body.documents
        }
        _validate_markdown_links(markdown_by_path, set(allowed_paths))
        documents = [
            self._prepare_document(
                document.model_copy(
                    update={"markdown": markdown_by_path[document.relative_path]}
                )
            )
            for document in allocated
        ]
        self._write_new_version(asset_id, version, documents)
        self.library.create_summary_documents(documents)
        return SummaryGenerationResult(
            version=version,
            documents=self.documents(asset_id, version_id),
            context_capacity_unknown=capacity_unknown,
        )

    def create_child(
        self,
        root_document_id: str,
        request: SummaryDocumentCreate,
    ) -> SummaryDocument:
        root = self._require_document(root_document_id)
        if root.parent_document_id is not None:
            raise SummaryError("子文档下不能继续创建文档")
        documents = self.documents(root.asset_id, root.version_id)
        children = [
            document
            for document in documents
            if document.parent_document_id == root.document_id
        ]
        document = self._prepare_document(
            SummaryDocument(
                document_id=f"document-{uuid7().hex}",
                asset_id=root.asset_id,
                version_id=root.version_id,
                parent_document_id=root.document_id,
                title=request.title,
                markdown=request.markdown,
                position=len(children),
            )
        )
        updated_documents = [*documents, document]
        try:
            self._write_document(document)
            self._write_version_manifest(root.asset_id, root.version_id, updated_documents)
        except Exception:
            self._document_path(document).unlink(missing_ok=True)
            raise
        self.library.create_summary_documents([document])
        return self._require_document(document.document_id)

    def update_document(
        self,
        document_id: str,
        request: SummaryDocumentUpdate,
    ) -> SummaryDocument:
        document = self._require_document(document_id)
        if document.revision != request.expected_revision:
            raise SummaryRevisionConflictError("文档版本冲突，请重新加载后再保存")
        markdown = request.markdown if request.markdown is not None else document.markdown
        updated = document.model_copy(
            update={
                "title": request.title if request.title is not None else document.title,
                "markdown": markdown,
                "position": request.position if request.position is not None else document.position,
                "content_digest": markdown_digest(markdown),
                "revision": document.revision + 1,
                "updated_at": datetime.now(UTC),
            }
        )
        documents = [
            updated if item.document_id == document_id else item
            for item in self.documents(document.asset_id, document.version_id)
        ]
        if request.markdown is not None:
            self._write_document(updated)
        self._write_version_manifest(document.asset_id, document.version_id, documents)
        indexed = self.library.update_summary_document(
            document_id,
            request.expected_revision,
            title=request.title,
            relative_path=updated.relative_path,
            content_digest=updated.content_digest,
            position=request.position,
        )
        if indexed is None:
            raise SummaryRevisionConflictError("文档版本冲突，请重新加载后再保存")
        return indexed

    def apply_agent_edit(
        self,
        document_id: str,
        expected_revision: int,
        markdown: str,
        suggested_children: list[SummaryDocumentCreate],
    ) -> tuple[SummaryDocument, list[SummaryDocument]]:
        """把正文与新增子文档作为同一业务版本提交，失败时恢复全部文件。"""

        with self.library._lock:
            document = self._require_document(document_id)
            if document.revision != expected_revision:
                raise SummaryRevisionConflictError("文档版本冲突，请重新加载后再保存")
            documents = self.documents(document.asset_id, document.version_id)
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
            child_count = sum(
                item.parent_document_id == root_id for item in documents
            )
            children = [
                self._prepare_document(
                    SummaryDocument(
                        document_id=f"document-{uuid7().hex}",
                        asset_id=updated.asset_id,
                        version_id=updated.version_id,
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
            manifest_path = resolve_version_path(
                asset_directory,
                updated.version_id,
                SUMMARY_MANIFEST_FILE_NAME,
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
                manifest = load_version_manifest(
                    asset_directory,
                    updated.version_id,
                )
                write_version_manifest(
                    asset_directory,
                    build_version_manifest(
                        manifest.version,
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
        """撤销整个 Agent 版本；目标有后续修改时由调用方拒绝而不覆盖。"""

        with self.library._lock:
            document = self._require_document(document_id)
            if document.revision != expected_revision:
                raise SummaryRevisionConflictError("文档版本冲突，不能覆盖后续修改")
            documents = self.documents(document.asset_id, document.version_id)
            removable_documents = [
                item for item in documents if item.document_id in remove_document_ids
            ]
            if {item.document_id for item in removable_documents} != set(
                remove_document_ids
            ):
                raise SummaryRevisionConflictError("新增子文档已变化，不能整批撤销")
            manifest = load_version_manifest(
                self.library.asset_directory(document.asset_id),
                document.version_id,
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
            manifest_path = resolve_version_path(
                asset_directory,
                document.version_id,
                SUMMARY_MANIFEST_FILE_NAME,
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
                write_version_manifest(
                    asset_directory,
                    build_version_manifest(
                        manifest.version,
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

    def reorder_children(
        self,
        root_document_id: str,
        document_ids: list[str],
    ) -> list[SummaryDocument]:
        root = self._require_document(root_document_id)
        documents = self.documents(root.asset_id, root.version_id)
        current_ids = {
            document.document_id
            for document in documents
            if document.parent_document_id == root_document_id
        }
        if set(document_ids) != current_ids or len(document_ids) != len(current_ids):
            raise ValueError("排序列表必须包含全部子文档且不能重复")
        positions = {document_id: position for position, document_id in enumerate(document_ids)}
        now = datetime.now(UTC)
        reordered = [
            document.model_copy(
                update={
                    "position": positions[document.document_id],
                    "revision": document.revision + 1,
                    "updated_at": now,
                }
            )
            if document.document_id in positions
            else document
            for document in documents
        ]
        self._write_version_manifest(root.asset_id, root.version_id, reordered)
        self.library.reorder_summary_documents(root_document_id, document_ids)
        return self.documents(root.asset_id, root.version_id)

    def delete_child(self, document_id: str) -> None:
        document = self._require_document(document_id)
        if document.parent_document_id is None:
            raise ValueError("主文档不能单独删除")
        remaining = [
            item
            for item in self.documents(document.asset_id, document.version_id)
            if item.document_id != document_id
        ]
        self._write_version_manifest(document.asset_id, document.version_id, remaining)
        if not self.library.delete_summary_document(document_id):
            raise SummaryNotFoundError("总结文档不存在")
        self._document_path(document).unlink(missing_ok=True)

    def create_media(
        self,
        request: SummaryMediaCreate,
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
        version = self._require_version(asset.asset_id, document.version_id)
        version_media_path = f"{SUMMARY_ASSETS_DIRECTORY_NAME}/{media_id}{suffix}"
        relative_path = (
            f"{SUMMARY_DIRECTORY_NAME}/{version.relative_path}/{version_media_path}"
        )
        output_path = resolve_version_path(
            self.library.asset_directory(asset.asset_id),
            version.version_id,
            version_media_path,
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
            version_id=document.version_id,
            document_id=document.document_id,
            media_type=request.media_type,
            relative_path=relative_path,
            caption=request.caption,
            start_seconds=request.start_seconds,
            end_seconds=end_seconds,
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
        try:
            updated = self.update_document(
                document.document_id,
                SummaryDocumentUpdate(
                    expected_revision=document.revision,
                    markdown=updated_markdown,
                ),
            )
        except SummaryRevisionConflictError:
            raise SummaryRevisionConflictError("媒体已生成，但文档版本发生冲突")
        self.library.save_summary_media(artifact)
        return artifact, updated

    def export(
        self,
        asset_id: str,
        version_id: str | None = None,
    ) -> SummaryExportResult:
        asset = self._require_asset(asset_id)
        version = (
            self._require_version(asset_id, version_id)
            if version_id
            else self.current_version(asset_id)
        )
        if version is None:
            raise SummaryNotFoundError("请先生成总结版本")
        documents = self.documents(asset_id, version.version_id)
        root = next(
            (document for document in documents if document.parent_document_id is None),
            None,
        )
        if root is None:
            raise SummaryNotFoundError("总结版本缺少主文档")
        media = self.library.load_summary_media(asset_id, version.version_id)
        exported_at = datetime.now().astimezone()
        export_manifest = {
            "format_version": 2,
            "asset": {
                "asset_id": asset.asset_id,
                "title": asset.title,
                "source_url": asset.source_url,
                "source_platform": asset.source_platform.value,
            },
            "version": version.model_dump(mode="json"),
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
        file_name = f"summary-{timestamp}-{version.version_id}-{export_id}.zip"
        output_directory = (
            self.library.asset_directory(asset_id)
            / SUMMARY_OUTPUT_DIRECTORY_NAME
            / version.version_id
        )
        if output_directory.is_symlink():
            raise SummaryError("总结导出目录不能是符号链接")
        output_path = output_directory / file_name
        content = buffer.getvalue()
        atomic_write_bytes(output_path, content)
        return SummaryExportResult(
            export_id=export_id,
            version_id=version.version_id,
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

    def _formal_context(
        self,
        asset_id: str,
    ) -> tuple[str, SummaryContextSummary]:
        transcript = self.library.load_transcript(asset_id)
        if transcript is None:
            raise SummaryError("请先完成视频转录")
        markers = [
            marker
            for marker in self.library.load_markers(asset_id)
            if marker.end_seconds is not None
        ]
        analyses = [
            analysis
            for analysis in self.library.load_event_analyses(asset_id)
            if analysis.target.source == "marker"
            and analysis.status == EventAnalysisStatus.VALID
        ]
        transcript_values = [segment.model_dump(mode="json") for segment in transcript.segments]
        marker_values = []
        for marker in markers:
            excerpts = [
                segment.model_dump(mode="json")
                for segment in transcript.segments
                if segment.end_seconds > marker.start_seconds
                and segment.start_seconds < marker.end_seconds
            ]
            marker_values.append(
                {**marker.model_dump(mode="json"), "transcript": excerpts}
            )
        analysis_values = [analysis.model_dump(mode="json") for analysis in analyses]
        context = (
            "<完整转录>\n"
            + json.dumps(transcript_values, ensure_ascii=False)
            + "\n</完整转录>\n\n<正式范围标记重点区域>\n"
            + json.dumps(marker_values, ensure_ascii=False)
            + "\n</正式范围标记重点区域>\n\n<有效 marker 事件分析>\n"
            + json.dumps(analysis_values, ensure_ascii=False)
            + "\n</有效 marker 事件分析>"
        )
        return context, SummaryContextSummary(
            transcript_digest=_digest(transcript_values),
            marker_digest=_digest(marker_values),
            event_analysis_digest=_digest(analysis_values),
        )

    def _preflight(
        self,
        model,
        minimum_context_tokens: int,
        stage: str,
        messages: list[dict[str, str]],
        output_tokens: int,
    ) -> bool:
        profile = self.capability_resolver.resolve(model)
        context_tokens = profile.limits.context_tokens
        max_output_tokens = profile.limits.max_output_tokens
        if context_tokens is not None and context_tokens < minimum_context_tokens:
            raise SummaryCapacityError(stage, minimum_context_tokens, context_tokens)
        if max_output_tokens is not None and output_tokens > max_output_tokens:
            raise SummaryCapacityError(stage, output_tokens, max_output_tokens)
        try:
            input_tokens = litellm.token_counter(
                model=model.litellm_model,
                messages=messages,
            )
        except Exception:
            return True
        required_tokens = input_tokens + output_tokens
        if context_tokens is not None and required_tokens > context_tokens:
            raise SummaryCapacityError(stage, required_tokens, context_tokens)
        return context_tokens is None or max_output_tokens is None

    def _write_new_version(
        self,
        asset_id: str,
        version: SummaryVersion,
        documents: list[SummaryDocument],
    ) -> None:
        asset_directory = self.library.asset_directory(asset_id)
        target = resolve_summary_path(asset_directory, version.relative_path)
        temporary = target.with_name(f".{version.version_id}.creating")
        temporary.mkdir(parents=True, exist_ok=False)
        try:
            for document in documents:
                path = temporary / document.relative_path
                atomic_write_text(path, document.markdown)
            manifest = build_version_manifest(version, documents, [])
            atomic_write_text(
                temporary / SUMMARY_MANIFEST_FILE_NAME,
                manifest.model_dump_json(indent=2),
            )
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(temporary, target)
            root_path = resolve_summary_path(
                asset_directory,
                SUMMARY_MANIFEST_FILE_NAME,
            )
            if root_path.exists():
                root = load_root_manifest(asset_directory)
                root = root.model_copy(
                    update={
                        "current_version_id": version.version_id,
                        "versions": [*root.versions, version],
                        "updated_at": datetime.now(UTC),
                    }
                )
            else:
                root = SummaryRootManifest(
                    asset_id=asset_id,
                    current_version_id=version.version_id,
                    versions=[version],
                )
            write_root_manifest(asset_directory, root)
        except Exception:
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            raise
        finally:
            if temporary.is_dir():
                shutil.rmtree(temporary)

    def _write_version_manifest(
        self,
        asset_id: str,
        version_id: str,
        documents: list[SummaryDocument],
    ) -> None:
        asset_directory = self.library.asset_directory(asset_id)
        manifest = load_version_manifest(asset_directory, version_id)
        media = self.library.load_summary_media(asset_id, version_id)
        write_version_manifest(
            asset_directory,
            build_version_manifest(manifest.version, documents, media),
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
        return resolve_version_path(
            self.library.asset_directory(document.asset_id),
            document.version_id,
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

    def _require_version(self, asset_id: str, version_id: str) -> SummaryVersion:
        version = next(
            (
                item
                for item in self.library.load_summary_versions(asset_id)
                if item.version_id == version_id
            ),
            None,
        )
        if version is None:
            raise SummaryNotFoundError("总结版本不存在")
        return version


def _allocate_documents(
    asset_id: str,
    version_id: str,
    plan: SummaryPlan,
) -> list[SummaryDocument]:
    identifiers = {
        item.key: f"document-{uuid7().hex}" for item in plan.documents
    }
    root = next(item for item in plan.documents if item.parent_key is None)
    documents = []
    child_position = 0
    for item in plan.documents:
        parent_id = identifiers[item.parent_key] if item.parent_key else None
        position = 0 if item.key == root.key else child_position
        if item.key != root.key:
            child_position += 1
        document = SummaryDocument(
            document_id=identifiers[item.key],
            asset_id=asset_id,
            version_id=version_id,
            parent_document_id=parent_id,
            title=item.title,
            position=position,
        )
        documents.append(
            document.model_copy(update={"relative_path": document_relative_path(document)})
        )
    return documents


def _plan_messages(
    asset_title: str,
    context: str,
    preset_prompt: str,
    request: SummaryGenerationRequest,
) -> list[dict[str, str]]:
    return [
        {
            "role": "system",
            "content": (
                "你负责规划 Markdown 总结的文档树，但此阶段不能写正文。"
                "只返回 JSON：{\"documents\":[{\"key\":\"root\","
                "\"title\":\"...\",\"parent_key\":null}]}。"
                "必须只有一个根文档，其他文档只能是根文档的一级子文档。"
            ),
        },
        {
            "role": "user",
            "content": _generation_control(asset_title, context, preset_prompt, request),
        },
    ]


def _body_messages(
    asset_title: str,
    context: str,
    preset_prompt: str,
    request: SummaryGenerationRequest,
    version: SummaryVersion,
    documents: list[SummaryDocument],
) -> list[dict[str, str]]:
    path_table = [
        {
            "relative_path": document.relative_path,
            "title": document.title,
            "parent_document_id": document.parent_document_id,
        }
        for document in documents
    ]
    return [
        {
            "role": "system",
            "content": (
                "你负责生成 Markdown 正文。只返回 JSON："
                "{\"documents\":[{\"relative_path\":\"index.md\","
                "\"markdown\":\"...\"}]}。不得返回或构造路径表以外的路径。"
                "文档之间只能使用路径表中的相对路径建立链接。"
            ),
        },
        {
            "role": "user",
            "content": (
                _generation_control(asset_title, context, preset_prompt, request)
                + "\n\n<当前版本目录>\n"
                + version.relative_path
                + "\n</当前版本目录>\n\n<允许路径表>\n"
                + json.dumps(path_table, ensure_ascii=False)
                + "\n</允许路径表>"
            ),
        },
    ]


def _generation_control(
    asset_title: str,
    context: str,
    preset_prompt: str,
    request: SummaryGenerationRequest,
) -> str:
    return (
        f"视频标题：{asset_title}\n\n{context}\n\n<总结角色>\n{preset_prompt}"
        f"\n</总结角色>\n\n<本次用户补充要求>\n{request.user_input or '无'}"
        f"\n</本次用户补充要求>\n\n详细程度：{request.detail.value}"
        f"\n输出语言：{request.output_language}"
    )


def _digest(value: object) -> str:
    content = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _strip_code_fence(content: str) -> str:
    stripped = content.strip()
    if stripped.startswith("```") and stripped.endswith("```"):
        first_line_end = stripped.find("\n")
        if first_line_end >= 0:
            return stripped[first_line_end + 1 : -3].strip()
    return stripped


MARKDOWN_LINK_PATTERN = re.compile(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)")
EXTERNAL_LINK_SCHEMES = ("http://", "https://", "mailto:")


def _validate_markdown_links(
    markdown_by_path: dict[str, str],
    allowed_paths: set[str],
) -> None:
    """模型只能链接本版本预分配文档，避免链接逃逸或悬空文件。"""
    for source_path, markdown in markdown_by_path.items():
        source_directory = PurePosixPath(source_path).parent.as_posix()
        for match in MARKDOWN_LINK_PATTERN.finditer(markdown):
            destination = match.group(1).strip("<>")
            if (
                destination.startswith("#")
                or destination.lower().startswith(EXTERNAL_LINK_SCHEMES)
            ):
                continue
            path_without_fragment = destination.split("#", 1)[0].split("?", 1)[0]
            if not path_without_fragment:
                continue
            combined = posixpath.normpath(
                posixpath.join(source_directory, path_without_fragment)
            )
            if combined.startswith("../") or combined not in allowed_paths:
                raise SummaryError("总结正文包含未预分配或越界的相对链接")


def _insert_markdown(markdown: str, insert_after: str | None, content: str) -> str:
    insertion = f"\n\n{content}\n"
    if insert_after is None:
        return markdown.rstrip() + insertion
    occurrences = [match.start() for match in re.finditer(re.escape(insert_after), markdown)]
    if len(occurrences) != 1:
        raise SummaryError("媒体插入锚点必须在文档中唯一存在")
    index = occurrences[0] + len(insert_after)
    return markdown[:index] + insertion + markdown[index:]
