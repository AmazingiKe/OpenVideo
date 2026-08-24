"""总结项目的文件布局、manifest 契约和安全原子写入。"""

from __future__ import annotations

import hashlib
import os
import tempfile
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

from pydantic import BaseModel, Field

from openvideo.core.summary_models import SummaryDocument, SummaryMediaArtifact


SUMMARY_DIRECTORY_NAME = "summary"
SUMMARY_OUTPUT_DIRECTORY_NAME = "summary_output"
SUMMARY_ASSETS_DIRECTORY_NAME = "assets"
SUMMARY_DOCUMENTS_DIRECTORY_NAME = "docs"
SUMMARY_INDEX_FILE_NAME = "index.md"
SUMMARY_MANIFEST_FILE_NAME = "manifest.json"
SUMMARY_MANIFEST_FORMAT_VERSION = 1


class SummaryManifestDocument(BaseModel):
    document_id: str
    parent_document_id: str | None
    title: str
    position: int = Field(ge=0)
    revision: int = Field(ge=1)
    relative_path: str
    content_digest: str
    created_at: datetime
    updated_at: datetime


class SummaryManifest(BaseModel):
    format_version: int = SUMMARY_MANIFEST_FORMAT_VERSION
    asset_id: str
    root_document_id: str
    documents: list[SummaryManifestDocument]
    media: list[SummaryMediaArtifact] = Field(default_factory=list)
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


def load_manifest(asset_directory: Path) -> SummaryManifest:
    path = resolve_summary_path(
        asset_directory,
        SUMMARY_MANIFEST_FILE_NAME,
        require_file=True,
    )
    manifest = SummaryManifest.model_validate_json(path.read_text(encoding="utf-8"))
    if manifest.format_version != SUMMARY_MANIFEST_FORMAT_VERSION:
        raise ValueError("总结 manifest 版本不受支持")
    return manifest


def build_manifest(
    asset_id: str,
    documents: list[SummaryDocument],
    media: list[SummaryMediaArtifact],
    *,
    updated_at: datetime | None = None,
) -> SummaryManifest:
    root = next(
        (document for document in documents if document.parent_document_id is None),
        None,
    )
    if root is None:
        raise ValueError("总结项目缺少主文档")
    return SummaryManifest(
        asset_id=asset_id,
        root_document_id=root.document_id,
        documents=[
            SummaryManifestDocument.model_validate(
                document.model_dump(exclude={"asset_id", "markdown"})
            )
            for document in documents
        ],
        media=media,
        updated_at=updated_at or datetime.now(UTC),
    )


def write_manifest(asset_directory: Path, manifest: SummaryManifest) -> None:
    path = resolve_summary_path(asset_directory, SUMMARY_MANIFEST_FILE_NAME)
    atomic_write_text(path, manifest.model_dump_json(indent=2))
