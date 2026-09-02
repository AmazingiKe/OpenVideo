"""唯一当前笔记的 manifest 契约与安全原子写入。"""

from __future__ import annotations

import hashlib
import os
import tempfile
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

from pydantic import BaseModel, Field

from openvideo.core.summary_models import (
    SummaryContextSummary,
    SummaryDetail,
    SummaryDocument,
    SummaryMediaArtifact,
    SummaryProject,
)


SUMMARY_DIRECTORY_NAME = "summary"
SUMMARY_OUTPUT_DIRECTORY_NAME = "summary_output"
SUMMARY_ASSETS_DIRECTORY_NAME = "assets"
SUMMARY_DOCUMENTS_DIRECTORY_NAME = "docs"
SUMMARY_SESSION_DIRECTORY_NAME = ".session"
SUMMARY_INDEX_FILE_NAME = "index.md"
SUMMARY_MANIFEST_FILE_NAME = "manifest.json"
SUMMARY_MANIFEST_FORMAT_VERSION = 3
SUMMARY_DOCUMENT_MAX_DEPTH = 2
SUMMARY_RECENT_OPERATION_LIMIT = 128


class SummaryManifestDocument(BaseModel):
    document_id: str = Field(pattern=r"^document-[0-9a-f]{32}$")
    parent_document_id: str | None
    title: str
    position: int = Field(ge=0)
    revision: int = Field(ge=1)
    relative_path: str
    content_digest: str
    created_at: datetime
    updated_at: datetime


class SummaryManifestOperation(BaseModel):
    """记录近期客户端写入，避免响应丢失后重复执行同一操作。"""

    operation_id: str = Field(pattern=r"^summary-operation-[0-9a-f]{32}$")
    client_id: str = Field(pattern=r"^summary-client-[0-9a-f]{32}$")
    client_sequence: int = Field(ge=1)
    document_id: str
    completed_at: datetime


class SummaryManifest(BaseModel):
    format_version: int = SUMMARY_MANIFEST_FORMAT_VERSION
    asset_id: str
    revision: int = Field(ge=1)
    root_document_id: str
    documents: list[SummaryManifestDocument]
    media: list[SummaryMediaArtifact] = Field(default_factory=list)
    recent_operations: list[SummaryManifestOperation] = Field(default_factory=list)
    client_sequences: dict[str, int] = Field(default_factory=dict)
    preset_id: str
    preset_version: int = Field(ge=1)
    user_input: str | None = None
    ai_model_id: str
    detail: SummaryDetail
    output_language: str
    context_summary: SummaryContextSummary
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


def document_relative_path(document: SummaryDocument) -> str:
    if document.parent_document_id is None:
        return SUMMARY_INDEX_FILE_NAME
    return f"{SUMMARY_DOCUMENTS_DIRECTORY_NAME}/{document.document_id}.md"


def markdown_digest(markdown: str) -> str:
    return hashlib.sha256(markdown.encode("utf-8")).hexdigest()


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def summary_directory(asset_directory: Path) -> Path:
    path = asset_directory / SUMMARY_DIRECTORY_NAME
    if path.is_symlink():
        raise ValueError("总结目录不能是符号链接")
    return path


def resolve_summary_path(
    asset_directory: Path,
    relative_path: str,
    *,
    require_file: bool = False,
) -> Path:
    relative = PurePosixPath(relative_path)
    if relative.is_absolute() or ".." in relative.parts or not relative.parts:
        raise ValueError("总结相对路径无效")
    root = summary_directory(asset_directory).resolve()
    candidate = root.joinpath(*relative.parts)
    for parent in (root, *candidate.parents):
        if parent == root.parent:
            break
        if parent.exists() and parent.is_symlink():
            raise ValueError("总结路径不能经过符号链接")
    resolved = candidate.resolve()
    if not resolved.is_relative_to(root):
        raise ValueError("总结路径超出素材目录")
    if require_file and (not resolved.is_file() or resolved.is_symlink()):
        raise FileNotFoundError(relative_path)
    return resolved


def read_markdown(asset_directory: Path, relative_path: str) -> str:
    return resolve_summary_path(
        asset_directory,
        relative_path,
        require_file=True,
    ).read_text(encoding="utf-8")


def atomic_write_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError("写入目标不能是符号链接")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def atomic_write_text(path: Path, content: str) -> None:
    atomic_write_bytes(path, content.encode("utf-8"))


def load_summary_manifest(asset_directory: Path) -> SummaryManifest:
    path = resolve_summary_path(
        asset_directory,
        SUMMARY_MANIFEST_FILE_NAME,
        require_file=True,
    )
    manifest = SummaryManifest.model_validate_json(path.read_text(encoding="utf-8"))
    if manifest.format_version != SUMMARY_MANIFEST_FORMAT_VERSION:
        raise ValueError("总结 manifest 版本不受支持")
    return manifest


def project_from_manifest(manifest: SummaryManifest) -> SummaryProject:
    return SummaryProject.model_validate(
        manifest.model_dump(
            exclude={
                "format_version",
                "documents",
                "media",
                "recent_operations",
                "client_sequences",
            }
        )
    )


def build_summary_manifest(
    project: SummaryProject,
    documents: list[SummaryDocument],
    media: list[SummaryMediaArtifact],
    *,
    recent_operations: list[SummaryManifestOperation] | None = None,
    client_sequences: dict[str, int] | None = None,
    updated_at: datetime | None = None,
) -> SummaryManifest:
    if any(document.asset_id != project.asset_id for document in documents):
        raise ValueError("总结文档不属于当前素材")
    if any(artifact.asset_id != project.asset_id for artifact in media):
        raise ValueError("总结媒体不属于当前素材")
    summary_document_depths(documents)
    root = next(
        (document for document in documents if document.parent_document_id is None),
        None,
    )
    if root is None or root.document_id != project.root_document_id:
        raise ValueError("总结项目缺少主文档")
    resolved_updated_at = updated_at or datetime.now(UTC)
    resolved_operations = (recent_operations or [])[-SUMMARY_RECENT_OPERATION_LIMIT:]
    retained_clients = {operation.client_id for operation in resolved_operations}
    resolved_client_sequences = {
        client_id: sequence
        for client_id, sequence in (client_sequences or {}).items()
        if client_id in retained_clients
    }
    return SummaryManifest(
        **project.model_dump(exclude={"updated_at"}),
        documents=[
            SummaryManifestDocument.model_validate(
                document.model_dump(exclude={"asset_id", "markdown"})
            )
            for document in documents
        ],
        media=media,
        recent_operations=resolved_operations,
        client_sequences=resolved_client_sequences,
        updated_at=resolved_updated_at,
    )


def summary_document_depths(documents: list[SummaryDocument]) -> dict[str, int]:
    """验证当前笔记的三级文档树，并返回以主文档为零的层级。"""

    by_id = {document.document_id: document for document in documents}
    if len(by_id) != len(documents):
        raise ValueError("总结文档标识不能重复")
    roots = [document for document in documents if document.parent_document_id is None]
    if len(roots) != 1:
        raise ValueError("总结项目必须只有一篇主文档")
    if any(
        document.parent_document_id is not None
        and document.parent_document_id not in by_id
        for document in documents
    ):
        raise ValueError("总结文档引用了不存在的父文档")

    depths: dict[str, int] = {}
    visiting: set[str] = set()

    def resolve_depth(document_id: str) -> int:
        if document_id in depths:
            return depths[document_id]
        if document_id in visiting:
            raise ValueError("总结文档树不能形成循环")
        visiting.add(document_id)
        document = by_id[document_id]
        depth = (
            0
            if document.parent_document_id is None
            else resolve_depth(document.parent_document_id) + 1
        )
        visiting.remove(document_id)
        if depth > SUMMARY_DOCUMENT_MAX_DEPTH:
            raise ValueError("总结文档最多支持三级")
        depths[document_id] = depth
        return depth

    for document in documents:
        resolve_depth(document.document_id)
    return depths


def write_summary_manifest(asset_directory: Path, manifest: SummaryManifest) -> None:
    path = resolve_summary_path(asset_directory, SUMMARY_MANIFEST_FILE_NAME)
    atomic_write_text(path, manifest.model_dump_json(indent=2))
