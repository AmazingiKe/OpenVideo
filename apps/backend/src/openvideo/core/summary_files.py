"""总结多版本目录、manifest 契约与安全原子写入。"""

from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

from pydantic import BaseModel, Field

from openvideo.core.identifiers import is_prefixed_uuid7, uuid7
from openvideo.core.summary_models import (
    SummaryContextSummary,
    SummaryDetail,
    SummaryDocument,
    SummaryMediaArtifact,
    SummaryVersion,
)


SUMMARY_DIRECTORY_NAME = "summary"
SUMMARY_OUTPUT_DIRECTORY_NAME = "summary_output"
SUMMARY_VERSIONS_DIRECTORY_NAME = "versions"
SUMMARY_ASSETS_DIRECTORY_NAME = "assets"
SUMMARY_DOCUMENTS_DIRECTORY_NAME = "docs"
SUMMARY_INDEX_FILE_NAME = "index.md"
SUMMARY_MANIFEST_FILE_NAME = "manifest.json"
SUMMARY_ROOT_MANIFEST_FORMAT_VERSION = 2
SUMMARY_VERSION_MANIFEST_FORMAT_VERSION = 1
SUMMARY_DOCUMENT_MAX_DEPTH = 2
SUMMARY_VERSION_ID_PREFIX = "summary-version-"
LEGACY_SUMMARY_PRESET_ID = "legacy_import"
LEGACY_SUMMARY_MODEL_ID = "legacy"
LEGACY_SUMMARY_OUTPUT_LANGUAGE = "auto"


class SummaryManifestDocument(BaseModel):
    document_id: str
    version_id: str
    parent_document_id: str | None
    title: str
    position: int = Field(ge=0)
    revision: int = Field(ge=1)
    relative_path: str
    content_digest: str
    created_at: datetime
    updated_at: datetime


class SummaryVersionManifest(BaseModel):
    format_version: int = SUMMARY_VERSION_MANIFEST_FORMAT_VERSION
    asset_id: str
    version: SummaryVersion
    root_document_id: str
    documents: list[SummaryManifestDocument]
    media: list[SummaryMediaArtifact] = Field(default_factory=list)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class SummaryRootManifest(BaseModel):
    format_version: int = SUMMARY_ROOT_MANIFEST_FORMAT_VERSION
    asset_id: str
    current_version_id: str
    versions: list[SummaryVersion]
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class _LegacyManifestDocument(BaseModel):
    document_id: str
    parent_document_id: str | None
    title: str
    position: int
    revision: int
    relative_path: str
    content_digest: str
    created_at: datetime
    updated_at: datetime


class _LegacySummaryManifest(BaseModel):
    format_version: int = 1
    asset_id: str
    root_document_id: str
    documents: list[_LegacyManifestDocument]
    media: list[dict[str, object]] = Field(default_factory=list)
    updated_at: datetime


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


def version_relative_directory(version_id: str) -> str:
    if not is_prefixed_uuid7(version_id, SUMMARY_VERSION_ID_PREFIX):
        raise ValueError("总结版本标识无效")
    return f"{SUMMARY_VERSIONS_DIRECTORY_NAME}/{version_id}"


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


def resolve_version_path(
    asset_directory: Path,
    version_id: str,
    relative_path: str,
    *,
    require_file: bool = False,
) -> Path:
    return resolve_summary_path(
        asset_directory,
        f"{version_relative_directory(version_id)}/{relative_path}",
        require_file=require_file,
    )


def read_markdown(
    asset_directory: Path,
    version_id: str,
    relative_path: str,
) -> str:
    return resolve_version_path(
        asset_directory,
        version_id,
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


def load_root_manifest(asset_directory: Path) -> SummaryRootManifest:
    path = resolve_summary_path(
        asset_directory,
        SUMMARY_MANIFEST_FILE_NAME,
        require_file=True,
    )
    content = path.read_text(encoding="utf-8")
    try:
        root = SummaryRootManifest.model_validate_json(content)
    except ValueError:
        legacy = _LegacySummaryManifest.model_validate_json(content)
        root = migrate_legacy_summary(asset_directory, legacy)
    if root.format_version != SUMMARY_ROOT_MANIFEST_FORMAT_VERSION:
        raise ValueError("总结根 manifest 版本不受支持")
    version_ids = [version.version_id for version in root.versions]
    if root.current_version_id not in version_ids or len(version_ids) != len(
        set(version_ids)
    ):
        raise ValueError("总结版本目录缺少当前版本或包含重复标识")
    _cleanup_legacy_layout(asset_directory)
    return root


def load_version_manifest(
    asset_directory: Path,
    version_id: str,
) -> SummaryVersionManifest:
    path = resolve_version_path(
        asset_directory,
        version_id,
        SUMMARY_MANIFEST_FILE_NAME,
        require_file=True,
    )
    manifest = SummaryVersionManifest.model_validate_json(
        path.read_text(encoding="utf-8")
    )
    if (
        manifest.format_version != SUMMARY_VERSION_MANIFEST_FORMAT_VERSION
        or manifest.version.version_id != version_id
    ):
        raise ValueError("总结版本 manifest 无效")
    return manifest


def build_version_manifest(
    version: SummaryVersion,
    documents: list[SummaryDocument],
    media: list[SummaryMediaArtifact],
    *,
    updated_at: datetime | None = None,
) -> SummaryVersionManifest:
    if any(document.version_id != version.version_id for document in documents):
        raise ValueError("总结文档不属于同一个版本")
    if any(artifact.version_id != version.version_id for artifact in media):
        raise ValueError("总结媒体不属于同一个版本")
    summary_document_depths(documents)
    root = next(
        (document for document in documents if document.parent_document_id is None),
        None,
    )
    if root is None:
        raise ValueError("总结版本缺少主文档")
    return SummaryVersionManifest(
        asset_id=version.asset_id,
        version=version,
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


def summary_document_depths(
    documents: list[SummaryDocument],
) -> dict[str, int]:
    """验证版本内的三级文档树，并返回以主文档为零的层级。"""

    by_id = {document.document_id: document for document in documents}
    if len(by_id) != len(documents):
        raise ValueError("总结文档标识不能重复")
    roots = [document for document in documents if document.parent_document_id is None]
    if len(roots) != 1:
        raise ValueError("总结版本必须只有一篇主文档")
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


def write_root_manifest(asset_directory: Path, manifest: SummaryRootManifest) -> None:
    path = resolve_summary_path(asset_directory, SUMMARY_MANIFEST_FILE_NAME)
    atomic_write_text(path, manifest.model_dump_json(indent=2))


def write_version_manifest(
    asset_directory: Path,
    manifest: SummaryVersionManifest,
) -> None:
    path = resolve_version_path(
        asset_directory,
        manifest.version.version_id,
        SUMMARY_MANIFEST_FILE_NAME,
    )
    atomic_write_text(path, manifest.model_dump_json(indent=2))


def migrate_legacy_summary(
    asset_directory: Path,
    legacy: _LegacySummaryManifest,
) -> SummaryRootManifest:
    """旧单版本布局只迁移一次；新根 manifest 提交后再删除旧文件。"""

    recovered_version = _find_recoverable_legacy_version(asset_directory, legacy)
    if recovered_version is not None:
        root = SummaryRootManifest(
            asset_id=legacy.asset_id,
            current_version_id=recovered_version.version_id,
            versions=[recovered_version],
            updated_at=legacy.updated_at,
        )
        write_root_manifest(asset_directory, root)
        _cleanup_legacy_layout(asset_directory, legacy)
        return root

    version_id = f"{SUMMARY_VERSION_ID_PREFIX}{uuid7().hex}"
    version = SummaryVersion(
        version_id=version_id,
        asset_id=legacy.asset_id,
        preset_id=LEGACY_SUMMARY_PRESET_ID,
        preset_version=1,
        ai_model_id=LEGACY_SUMMARY_MODEL_ID,
        detail=SummaryDetail.STANDARD,
        output_language=LEGACY_SUMMARY_OUTPUT_LANGUAGE,
        context_summary=SummaryContextSummary(
            transcript_digest="legacy",
            marker_digest="legacy",
            event_analysis_digest="legacy",
        ),
        relative_path=version_relative_directory(version_id),
        created_at=legacy.updated_at,
    )
    documents: list[SummaryDocument] = []
    for legacy_document in legacy.documents:
        source = resolve_summary_path(
            asset_directory,
            legacy_document.relative_path,
            require_file=True,
        )
        document = SummaryDocument(
            **legacy_document.model_dump(exclude={"relative_path"}),
            asset_id=legacy.asset_id,
            version_id=version_id,
            markdown=source.read_text(encoding="utf-8"),
        )
        documents.append(
            document.model_copy(
                update={"relative_path": document_relative_path(document)}
            )
        )
    media: list[SummaryMediaArtifact] = []
    for value in legacy.media:
        legacy_artifact = SummaryMediaArtifact.model_validate(
            {**value, "version_id": version_id}
        )
        file_name = PurePosixPath(legacy_artifact.relative_path).name
        media.append(
            legacy_artifact.model_copy(
                update={
                    "relative_path": (
                        f"{SUMMARY_DIRECTORY_NAME}/{version.relative_path}/"
                        f"{SUMMARY_ASSETS_DIRECTORY_NAME}/{file_name}"
                    )
                }
            )
        )

    target_directory = resolve_summary_path(asset_directory, version.relative_path)
    temporary_directory = target_directory.with_name(f".{version_id}.migration")
    temporary_directory.mkdir(parents=True, exist_ok=False)
    try:
        for document in documents:
            destination = temporary_directory / document.relative_path
            destination.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_text(destination, document.markdown)
        for artifact in media:
            file_name = PurePosixPath(artifact.relative_path).name
            source = (
                summary_directory(asset_directory)
                / SUMMARY_ASSETS_DIRECTORY_NAME
                / file_name
            )
            destination = (
                temporary_directory / SUMMARY_ASSETS_DIRECTORY_NAME / file_name
            )
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        manifest = build_version_manifest(version, documents, media)
        atomic_write_text(
            temporary_directory / SUMMARY_MANIFEST_FILE_NAME,
            manifest.model_dump_json(indent=2),
        )
        target_directory.parent.mkdir(parents=True, exist_ok=True)
        os.replace(temporary_directory, target_directory)
        root = SummaryRootManifest(
            asset_id=legacy.asset_id,
            current_version_id=version_id,
            versions=[version],
            updated_at=legacy.updated_at,
        )
        write_root_manifest(asset_directory, root)
        _cleanup_legacy_layout(asset_directory, legacy)
        return root
    finally:
        if temporary_directory.is_dir():
            shutil.rmtree(temporary_directory)


def _find_recoverable_legacy_version(
    asset_directory: Path,
    legacy: _LegacySummaryManifest,
) -> SummaryVersion | None:
    versions_directory = resolve_summary_path(
        asset_directory,
        SUMMARY_VERSIONS_DIRECTORY_NAME,
    )
    if not versions_directory.is_dir() or versions_directory.is_symlink():
        return None
    for candidate in sorted(versions_directory.iterdir()):
        version_id = candidate.name
        if (
            not candidate.is_dir()
            or candidate.is_symlink()
            or not is_prefixed_uuid7(version_id, SUMMARY_VERSION_ID_PREFIX)
        ):
            continue
        try:
            manifest = load_version_manifest(asset_directory, version_id)
        except (OSError, ValueError):
            continue
        if (
            manifest.asset_id == legacy.asset_id
            and manifest.root_document_id == legacy.root_document_id
            and manifest.version.preset_id == LEGACY_SUMMARY_PRESET_ID
        ):
            return manifest.version
    return None


def _cleanup_legacy_layout(
    asset_directory: Path,
    legacy: _LegacySummaryManifest | None = None,
) -> None:
    if legacy is not None:
        for document in legacy.documents:
            path = resolve_summary_path(asset_directory, document.relative_path)
            path.unlink(missing_ok=True)
    else:
        resolve_summary_path(
            asset_directory,
            SUMMARY_INDEX_FILE_NAME,
        ).unlink(missing_ok=True)
    for directory_name in (
        SUMMARY_DOCUMENTS_DIRECTORY_NAME,
        SUMMARY_ASSETS_DIRECTORY_NAME,
    ):
        legacy_directory = resolve_summary_path(asset_directory, directory_name)
        if legacy_directory.is_dir() and not legacy_directory.is_symlink():
            shutil.rmtree(legacy_directory)
