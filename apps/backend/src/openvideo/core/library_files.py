"""资料库业务文件的固定契约、原子写入与安全扫描。"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from pydantic import BaseModel, Field

from openvideo.core.identifiers import is_uuid7
from openvideo.core.media_models import (
    AssetMetadata,
    AssetSourceMetadata,
    AssetStoryboardMetadata,
    AssetTranscriptionMetadata,
    MediaAsset,
    MediaMarker,
    MediaSegment,
    MediaType,
    VideoMetadata,
)
from openvideo.core.transcription_models import Transcript, TranscriptionMetadata
from openvideo.core.summary_files import (
    SUMMARY_DIRECTORY_NAME,
    SUMMARY_MANIFEST_FILE_NAME,
    atomic_write_text,
    document_relative_path,
    load_manifest,
    markdown_digest,
    read_markdown,
)
from openvideo.core.summary_models import (
    SummaryConversation,
    SummaryDocument,
    SummaryEditProposal,
    SummaryMediaArtifact,
    SummaryMessage,
)


ASSET_METADATA_FILE_NAME = "meta.json"
ARTIFACTS_DIRECTORY_NAME = "artifacts"
TRANSCRIPT_FILE_NAME = "transcript.json"
TRANSCRIPTION_METADATA_FILE_NAME = "transcription.json"
TIMELINE_FILE_NAME = "timeline.json"
MARKERS_FILE_NAME = "markers.json"
CONVERSATIONS_DIRECTORY_NAME = "conversations"
DOMAIN_FILE_FORMAT_VERSION = 1


class IndexIssue(BaseModel):
    asset_id: str | None
    relative_path: str
    code: str
    message: str


class AssetIndexError(ValueError):
    def __init__(self, issue: IndexIssue) -> None:
        super().__init__(issue.message)
        self.issue = issue


class TimelineFile(BaseModel):
    format_version: int = DOMAIN_FILE_FORMAT_VERSION
    asset_id: str
    segments: list[MediaSegment] = Field(default_factory=list)


class MarkersFile(BaseModel):
    format_version: int = DOMAIN_FILE_FORMAT_VERSION
    asset_id: str
    markers: list[MediaMarker] = Field(default_factory=list)


class SummaryConversationFile(BaseModel):
    format_version: int = DOMAIN_FILE_FORMAT_VERSION
    conversation: SummaryConversation
    messages: list[SummaryMessage] = Field(default_factory=list)
    proposals: list[SummaryEditProposal] = Field(default_factory=list)


@dataclass(frozen=True)
class AssetFileBundle:
    asset: MediaAsset
    segments: list[MediaSegment]
    markers: list[MediaMarker]
    summary_documents: list[SummaryDocument]
    summary_media: list[SummaryMediaArtifact]
    conversations: list[SummaryConversationFile]
    digest: str


def atomic_write_model(path: Path, model: BaseModel) -> None:
    atomic_write_text(path, model.model_dump_json(indent=2))


def metadata_from_asset(
    asset: MediaAsset,
    transcription: TranscriptionMetadata | None,
    *,
    transcript_exists: bool,
) -> AssetMetadata:
    video = None
    if asset.media_type == MediaType.VIDEO:
        video = VideoMetadata(
            duration_seconds=asset.duration_seconds,
            width=asset.width,
            height=asset.height,
            video_codec=asset.video_codec,
            audio_codec=asset.audio_codec,
        )
    if transcription is not None:
        transcription_summary = AssetTranscriptionMetadata(
            status=transcription.status,
            attempt_count=transcription.attempt_count,
        )
    elif transcript_exists:
        transcription_summary = AssetTranscriptionMetadata(
            status="complete", attempt_count=1
        )
    else:
        transcription_summary = AssetTranscriptionMetadata()
    storyboard = None
    storyboard_values = (
        asset.thumbnail_sprite_path,
        asset.thumbnail_tile_width,
        asset.thumbnail_tile_height,
        asset.thumbnail_interval_seconds,
        asset.thumbnail_columns,
        asset.thumbnail_total_tiles,
    )
    if all(value is not None for value in storyboard_values):
        storyboard = AssetStoryboardMetadata(
            sprite_path=asset.thumbnail_sprite_path,
            tile_width=asset.thumbnail_tile_width,
            tile_height=asset.thumbnail_tile_height,
            interval_seconds=asset.thumbnail_interval_seconds,
            columns=asset.thumbnail_columns,
            total_tiles=asset.thumbnail_total_tiles,
        )
    return AssetMetadata(
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
        video=video,
        transcription=transcription_summary,
        status=asset.status,
        error_message=asset.error_message,
        playback_path=asset.playback_path,
        thumbnail_path=asset.thumbnail_path,
        remote_thumbnail_url=asset.remote_thumbnail_url,
        storyboard=storyboard,
        created_at=asset.created_at,
        updated_at=asset.updated_at,
    )


def asset_from_metadata(metadata: AssetMetadata) -> MediaAsset:
    video = metadata.video or VideoMetadata()
    storyboard = metadata.storyboard
    return MediaAsset(
        asset_id=metadata.asset_id,
        media_type=metadata.media_type,
        source_url=metadata.source.url,
        source_platform=metadata.source.platform,
        source_video_id=metadata.source.source_id,
        title=metadata.title,
        author_name=metadata.source.author_name,
        description=metadata.source.description,
        duration_seconds=video.duration_seconds,
        width=video.width,
        height=video.height,
        video_codec=video.video_codec,
        audio_codec=video.audio_codec,
        playback_path=metadata.playback_path,
        thumbnail_path=metadata.thumbnail_path,
        remote_thumbnail_url=metadata.remote_thumbnail_url,
        thumbnail_sprite_path=storyboard.sprite_path if storyboard else None,
        thumbnail_tile_width=storyboard.tile_width if storyboard else None,
        thumbnail_tile_height=storyboard.tile_height if storyboard else None,
        thumbnail_interval_seconds=storyboard.interval_seconds if storyboard else None,
        thumbnail_columns=storyboard.columns if storyboard else None,
        thumbnail_total_tiles=storyboard.total_tiles if storyboard else None,
        status=metadata.status,
        error_message=metadata.error_message,
        created_at=metadata.created_at,
        updated_at=metadata.updated_at,
    )


def load_asset_bundle(assets_root: Path, asset_directory: Path) -> AssetFileBundle:
    asset_id = asset_directory.name
    relative_directory = f"assets/{asset_id}"
    if asset_directory.is_symlink() or not asset_directory.is_dir():
        raise AssetIndexError(
            IndexIssue(
                asset_id=asset_id if is_uuid7(asset_id) else None,
                relative_path=relative_directory,
                code="unsafe_asset_directory",
                message="素材目录不能是符号链接且必须为目录",
            )
        )
    if not is_uuid7(asset_id):
        raise AssetIndexError(
            IndexIssue(
                asset_id=None,
                relative_path=relative_directory,
                code="invalid_asset_id",
                message="素材目录名必须是 UUIDv7",
            )
        )
    resolved_root = assets_root.resolve()
    if not asset_directory.resolve().is_relative_to(resolved_root):
        raise AssetIndexError(
            IndexIssue(
                asset_id=asset_id,
                relative_path=relative_directory,
                code="unsafe_asset_directory",
                message="素材目录超出资料库范围",
            )
        )

    tracked_paths: list[Path] = []
    metadata_path = asset_directory / ASSET_METADATA_FILE_NAME
    metadata = _read_model(
        metadata_path, AssetMetadata, asset_id, tracked_paths, assets_root.parent
    )
    if metadata.asset_id != asset_id:
        _raise_issue(asset_id, metadata_path, assets_root.parent, "cross_asset_reference", "meta.json 的素材标识与目录不一致")
    asset = asset_from_metadata(metadata)
    for relative_path in (
        asset.playback_path,
        asset.thumbnail_path,
        asset.thumbnail_sprite_path,
    ):
        if relative_path:
            _validate_asset_reference(asset_directory, relative_path, asset_id, assets_root.parent)

    transcript_path = asset_directory / ARTIFACTS_DIRECTORY_NAME / TRANSCRIPT_FILE_NAME
    transcription_path = (
        asset_directory / ARTIFACTS_DIRECTORY_NAME / TRANSCRIPTION_METADATA_FILE_NAME
    )
    _read_optional_asset_model(
        transcript_path, Transcript, asset_id, tracked_paths, assets_root.parent
    )
    _read_optional_asset_model(
        transcription_path,
        TranscriptionMetadata,
        asset_id,
        tracked_paths,
        assets_root.parent,
    )

    timeline_path = asset_directory / ARTIFACTS_DIRECTORY_NAME / TIMELINE_FILE_NAME
    timeline = _read_optional_model(
        timeline_path, TimelineFile, asset_id, tracked_paths, assets_root.parent
    )
    segments = timeline.segments if timeline else []
    if timeline and (timeline.format_version != DOMAIN_FILE_FORMAT_VERSION or timeline.asset_id != asset_id):
        _raise_issue(asset_id, timeline_path, assets_root.parent, "invalid_timeline", "时间轴文件版本或素材标识无效")
    for segment in segments:
        if segment.asset_id != asset_id:
            _raise_issue(asset_id, timeline_path, assets_root.parent, "cross_asset_reference", "时间轴包含其他素材的片段")
        for relative_path in segment.key_frame_paths:
            _validate_asset_reference(asset_directory, relative_path, asset_id, assets_root.parent)

    markers_path = asset_directory / MARKERS_FILE_NAME
    markers_file = _read_optional_model(
        markers_path, MarkersFile, asset_id, tracked_paths, assets_root.parent
    )
    markers = markers_file.markers if markers_file else []
    if markers_file and (
        markers_file.format_version != DOMAIN_FILE_FORMAT_VERSION
        or markers_file.asset_id != asset_id
    ):
        _raise_issue(asset_id, markers_path, assets_root.parent, "invalid_markers", "标记文件版本或素材标识无效")
    if any(marker.asset_id != asset_id for marker in markers):
        _raise_issue(asset_id, markers_path, assets_root.parent, "cross_asset_reference", "标记文件包含其他素材的标记")
    marker_ids = {marker.marker_id for marker in markers}
    if any(marker_id not in marker_ids for segment in segments for marker_id in segment.marker_ids):
        _raise_issue(asset_id, timeline_path, assets_root.parent, "missing_marker", "时间轴引用了不存在的素材标记")

    documents, media = _load_summary(
        asset_directory, asset_id, assets_root.parent, tracked_paths
    )
    conversations = _load_conversations(
        asset_directory,
        asset_id,
        {document.document_id for document in documents},
        next(
            (document.document_id for document in documents if document.parent_document_id is None),
            None,
        ),
        assets_root.parent,
        tracked_paths,
    )
    digest = _business_digest(asset_directory, tracked_paths)
    return AssetFileBundle(
        asset=asset,
        segments=segments,
        markers=markers,
        summary_documents=documents,
        summary_media=media,
        conversations=conversations,
        digest=digest,
    )


def conversation_file_path(asset_directory: Path, conversation_id: str) -> Path:
    return (
        asset_directory
        / SUMMARY_DIRECTORY_NAME
        / CONVERSATIONS_DIRECTORY_NAME
        / f"{conversation_id}.json"
    )


def _load_summary(
    asset_directory: Path,
    asset_id: str,
    library_root: Path,
    tracked_paths: list[Path],
) -> tuple[list[SummaryDocument], list[SummaryMediaArtifact]]:
    manifest_path = asset_directory / SUMMARY_DIRECTORY_NAME / SUMMARY_MANIFEST_FILE_NAME
    if not manifest_path.exists():
        tracked_paths.append(manifest_path)
        return [], []
    tracked_paths.append(manifest_path)
    try:
        manifest = load_manifest(asset_directory)
    except (OSError, ValueError):
        _raise_issue(
            asset_id,
            manifest_path,
            library_root,
            "invalid_summary_manifest",
            "总结 manifest 无效或无法读取",
        )
    if manifest.asset_id != asset_id:
        _raise_issue(asset_id, manifest_path, library_root, "cross_asset_reference", "总结 manifest 不属于当前素材")
    document_ids = {item.document_id for item in manifest.documents}
    if len(document_ids) != len(manifest.documents) or manifest.root_document_id not in document_ids:
        _raise_issue(asset_id, manifest_path, library_root, "invalid_summary_manifest", "总结文档标识重复或缺少主文档")
    documents: list[SummaryDocument] = []
    for item in manifest.documents:
        if item.parent_document_id is not None and item.parent_document_id != manifest.root_document_id:
            _raise_issue(asset_id, manifest_path, library_root, "cross_asset_reference", "总结子文档引用了无效主文档")
        expected_path = document_relative_path(
            SummaryDocument(
                **item.model_dump(), asset_id=asset_id, markdown=""
            )
        )
        if item.relative_path != expected_path:
            _raise_issue(asset_id, manifest_path, library_root, "unsafe_path", "总结文档路径不符合固定契约")
        markdown_path = asset_directory / SUMMARY_DIRECTORY_NAME / Path(item.relative_path)
        tracked_paths.append(markdown_path)
        try:
            markdown = read_markdown(asset_directory, item.relative_path)
        except (OSError, ValueError):
            _raise_issue(
                asset_id,
                markdown_path,
                library_root,
                "invalid_summary_document",
                "总结 Markdown 缺失、无效或无法读取",
            )
        digest = markdown_digest(markdown)
        revision = item.revision + 1 if digest != item.content_digest else item.revision
        documents.append(
            SummaryDocument(
                **item.model_dump(exclude={"content_digest", "revision"}),
                asset_id=asset_id,
                markdown=markdown,
                content_digest=digest,
                revision=revision,
            )
        )
    for artifact in manifest.media:
        if artifact.asset_id != asset_id or artifact.document_id not in document_ids:
            _raise_issue(asset_id, manifest_path, library_root, "cross_asset_reference", "总结媒体引用了其他素材或文档")
        prefix = f"{SUMMARY_DIRECTORY_NAME}/"
        if not artifact.relative_path.startswith(prefix):
            _raise_issue(asset_id, manifest_path, library_root, "unsafe_path", "总结媒体路径无效")
        _validate_asset_reference(
            asset_directory,
            artifact.relative_path,
            asset_id,
            library_root,
            require_file=True,
        )
    return documents, manifest.media


def _load_conversations(
    asset_directory: Path,
    asset_id: str,
    document_ids: set[str],
    root_document_id: str | None,
    library_root: Path,
    tracked_paths: list[Path],
) -> list[SummaryConversationFile]:
    directory = asset_directory / SUMMARY_DIRECTORY_NAME / CONVERSATIONS_DIRECTORY_NAME
    if not directory.exists():
        return []
    if directory.is_symlink() or not directory.is_dir():
        _raise_issue(asset_id, directory, library_root, "unsafe_path", "总结对话目录不能是符号链接")
    conversations: list[SummaryConversationFile] = []
    for path in sorted(directory.iterdir(), key=lambda item: item.name):
        if path.is_symlink() or not path.is_file() or path.suffix != ".json":
            _raise_issue(asset_id, path, library_root, "invalid_conversation_file", "总结对话目录只允许 JSON 文件")
        record = _read_model(
            path, SummaryConversationFile, asset_id, tracked_paths, library_root
        )
        conversation = record.conversation
        if (
            record.format_version != DOMAIN_FILE_FORMAT_VERSION
            or path.stem != conversation.conversation_id
            or conversation.asset_id != asset_id
            or conversation.root_document_id != root_document_id
        ):
            _raise_issue(asset_id, path, library_root, "cross_asset_reference", "总结对话元数据与当前素材不一致")
        if any(message.conversation_id != conversation.conversation_id for message in record.messages):
            _raise_issue(asset_id, path, library_root, "cross_asset_reference", "总结消息属于其他对话")
        if any(
            proposal.session_id
            != f"session-{conversation.conversation_id.removeprefix('conversation-')}"
            or proposal.document_id not in document_ids
            for proposal in record.proposals
        ):
            _raise_issue(asset_id, path, library_root, "cross_asset_reference", "总结建议引用了其他对话或文档")
        conversations.append(record)
    return conversations


def _read_optional_asset_model(
    path: Path,
    model_type: type[Transcript] | type[TranscriptionMetadata],
    asset_id: str,
    tracked_paths: list[Path],
    library_root: Path,
) -> None:
    model = _read_optional_model(
        path, model_type, asset_id, tracked_paths, library_root
    )
    if model is not None and model.asset_id != asset_id:
        _raise_issue(
            asset_id,
            path,
            library_root,
            "cross_asset_reference",
            "业务文件属于其他素材",
        )


def _read_optional_model(
    path: Path,
    model_type,
    asset_id: str,
    tracked_paths: list[Path],
    library_root: Path,
):
    tracked_paths.append(path)
    if not path.exists():
        return None
    return _read_model(path, model_type, asset_id, None, library_root)


def _read_model(
    path: Path,
    model_type,
    asset_id: str,
    tracked_paths: list[Path] | None,
    library_root: Path,
):
    if tracked_paths is not None:
        tracked_paths.append(path)
    if path.is_symlink() or not path.is_file():
        _raise_issue(asset_id, path, library_root, "unsafe_path", "业务文件不能是符号链接")
    try:
        return model_type.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        _raise_issue(
            asset_id,
            path,
            library_root,
            "invalid_json",
            "JSON 内容无效或无法读取",
        )


def _validate_asset_reference(
    asset_directory: Path,
    relative_path: str,
    asset_id: str,
    library_root: Path,
    *,
    require_file: bool = False,
) -> None:
    relative = PurePosixPath(relative_path)
    if relative.is_absolute() or not relative.parts or ".." in relative.parts:
        _raise_issue(asset_id, asset_directory / relative_path, library_root, "unsafe_path", "素材相对路径无效")
    resolved_root = asset_directory.resolve()
    candidate = resolved_root.joinpath(*relative.parts)
    if not candidate.resolve().is_relative_to(resolved_root):
        _raise_issue(asset_id, candidate, library_root, "unsafe_path", "素材路径超出当前素材目录")
    current = resolved_root
    for part in relative.parts:
        current /= part
        if current.exists() and current.is_symlink():
            _raise_issue(asset_id, current, library_root, "unsafe_path", "素材路径不能经过符号链接")
    if require_file and not candidate.is_file():
        _raise_issue(asset_id, candidate, library_root, "missing_file", "业务文件引用的媒体不存在")


def _business_digest(asset_directory: Path, tracked_paths: list[Path]) -> str:
    digest = hashlib.sha256()
    unique_paths = sorted(
        set(tracked_paths), key=lambda path: path.relative_to(asset_directory).as_posix()
    )
    for path in unique_paths:
        relative_path = path.relative_to(asset_directory).as_posix()
        digest.update(relative_path.encode("utf-8"))
        if not path.exists():
            digest.update(b"\0missing")
            continue
        digest.update(b"\0file\0")
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
    return digest.hexdigest()


def _raise_issue(
    asset_id: str | None,
    path: Path,
    library_root: Path,
    code: str,
    message: str,
) -> None:
    try:
        relative_path = path.resolve().relative_to(library_root.resolve()).as_posix()
    except ValueError:
        relative_path = path.name
    raise AssetIndexError(
        IndexIssue(
            asset_id=asset_id,
            relative_path=relative_path,
            code=code,
            message=message or code,
        )
    )
