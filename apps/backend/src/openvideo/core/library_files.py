"""资料库业务文件的固定契约、原子写入与安全扫描。"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import TypeVar

from pydantic import BaseModel, Field

from openvideo.core.event_analysis_models import (
    EventAnalysesFile,
    EventAnalysis,
    FocusSelection,
)
from openvideo.core.identifiers import is_uuid7
from openvideo.core.media_models import (
    AssetMetadata,
    AssetSourceMetadata,
    AssetTranscriptionMetadata,
    MediaAsset,
    MediaMarker,
    MediaSegment,
    MediaType,
    VideoMetadata,
)
from openvideo.core.summary_files import (
    SUMMARY_DIRECTORY_NAME,
    SUMMARY_MANIFEST_FILE_NAME,
    atomic_write_text,
    document_relative_path,
    load_summary_manifest,
    markdown_digest,
    read_markdown,
    summary_document_depths,
)
from openvideo.core.summary_models import (
    SummaryDocument,
    SummaryMediaArtifact,
)
from openvideo.core.transcription_models import Transcript, TranscriptionMetadata


AssetModel = TypeVar("AssetModel", Transcript, TranscriptionMetadata)
ASSET_METADATA_FILE_NAME = "meta.json"
VIDEO_CONFIGURATION_FILE_NAME = "video-config.json"
ARTIFACTS_DIRECTORY_NAME = "artifacts"
TRANSCRIPT_FILE_NAME = "transcript.json"
TRANSCRIPTION_METADATA_FILE_NAME = "transcription.json"
TIMELINE_FILE_NAME = "timeline.json"
MARKERS_FILE_NAME = "markers.json"
FOCUS_SELECTION_FILE_NAME = "focus-selection.json"
EVENT_ANALYSES_FILE_NAME = "event-analyses.json"
DOMAIN_FILE_FORMAT_VERSION = 1
MARKERS_FILE_FORMAT_VERSION = 3


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
    format_version: int = MARKERS_FILE_FORMAT_VERSION
    asset_id: str
    markers: list[MediaMarker] = Field(default_factory=list)


@dataclass(frozen=True)
class AssetFileBundle:
    asset: MediaAsset
    transcript: Transcript | None
    segments: list[MediaSegment]
    markers: list[MediaMarker]
    focus_selection: FocusSelection | None
    event_analyses: list[EventAnalysis]
    summary_documents: list[SummaryDocument]
    summary_media: list[SummaryMediaArtifact]
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
    return AssetMetadata(
        asset_id=asset.asset_id,
        folder_id=asset.folder_id,
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
        thumbnail_storyboard_manifest_path=(
            asset.thumbnail_storyboard_manifest_path
        ),
        created_at=asset.created_at,
        updated_at=asset.updated_at,
    )


def asset_from_metadata(metadata: AssetMetadata) -> MediaAsset:
    video = metadata.video or VideoMetadata()
    return MediaAsset(
        asset_id=metadata.asset_id,
        folder_id=metadata.folder_id,
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
        thumbnail_storyboard_manifest_path=(
            metadata.thumbnail_storyboard_manifest_path
        ),
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
        _raise_issue(
            asset_id,
            metadata_path,
            assets_root.parent,
            "cross_asset_reference",
            "meta.json 的素材标识与目录不一致",
        )
    asset = asset_from_metadata(metadata)
    for relative_path in (
        asset.playback_path,
        asset.thumbnail_path,
        asset.thumbnail_storyboard_manifest_path,
    ):
        if relative_path:
            _validate_asset_reference(
                asset_directory, relative_path, asset_id, assets_root.parent
            )

    transcript_path = asset_directory / ARTIFACTS_DIRECTORY_NAME / TRANSCRIPT_FILE_NAME
    transcription_path = (
        asset_directory / ARTIFACTS_DIRECTORY_NAME / TRANSCRIPTION_METADATA_FILE_NAME
    )
    transcript = _read_optional_asset_model(
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
    if timeline and (
        timeline.format_version != DOMAIN_FILE_FORMAT_VERSION
        or timeline.asset_id != asset_id
    ):
        _raise_issue(
            asset_id,
            timeline_path,
            assets_root.parent,
            "invalid_timeline",
            "时间轴文件版本或素材标识无效",
        )
    for segment in segments:
        if segment.asset_id != asset_id:
            _raise_issue(
                asset_id,
                timeline_path,
                assets_root.parent,
                "cross_asset_reference",
                "时间轴包含其他素材的片段",
            )
        for relative_path in segment.key_frame_paths:
            _validate_asset_reference(
                asset_directory, relative_path, asset_id, assets_root.parent
            )

    markers_path = asset_directory / MARKERS_FILE_NAME
    markers_file = _read_optional_model(
        markers_path, MarkersFile, asset_id, tracked_paths, assets_root.parent
    )
    markers = markers_file.markers if markers_file else []
    if markers_file and (
        markers_file.format_version != MARKERS_FILE_FORMAT_VERSION
        or markers_file.asset_id != asset_id
    ):
        _raise_issue(
            asset_id,
            markers_path,
            assets_root.parent,
            "invalid_markers",
            "标记文件版本或素材标识无效",
        )
    if any(marker.asset_id != asset_id for marker in markers):
        _raise_issue(
            asset_id,
            markers_path,
            assets_root.parent,
            "cross_asset_reference",
            "标记文件包含其他素材的标记",
        )
    markers_by_id = {marker.marker_id: marker for marker in markers}
    marker_ids = set(markers_by_id)
    if any(
        marker_id not in marker_ids
        for segment in segments
        for marker_id in segment.marker_ids
    ):
        _raise_issue(
            asset_id,
            timeline_path,
            assets_root.parent,
            "missing_marker",
            "时间轴引用了不存在的素材标记",
        )

    focus_selection_path = (
        asset_directory / ARTIFACTS_DIRECTORY_NAME / FOCUS_SELECTION_FILE_NAME
    )
    focus_selection = _read_optional_model(
        focus_selection_path,
        FocusSelection,
        asset_id,
        tracked_paths,
        assets_root.parent,
    )
    if focus_selection is not None and focus_selection.asset_id != asset_id:
        _raise_issue(
            asset_id,
            focus_selection_path,
            assets_root.parent,
            "cross_asset_reference",
            "焦点选区不属于当前素材",
        )

    event_analyses_path = (
        asset_directory / ARTIFACTS_DIRECTORY_NAME / EVENT_ANALYSES_FILE_NAME
    )
    event_analyses_file = _read_optional_model(
        event_analyses_path,
        EventAnalysesFile,
        asset_id,
        tracked_paths,
        assets_root.parent,
    )
    event_analyses = event_analyses_file.analyses if event_analyses_file else []
    if event_analyses_file is not None and (
        event_analyses_file.format_version != DOMAIN_FILE_FORMAT_VERSION
        or event_analyses_file.asset_id != asset_id
        or any(analysis.asset_id != asset_id for analysis in event_analyses)
    ):
        _raise_issue(
            asset_id,
            event_analyses_path,
            assets_root.parent,
            "invalid_event_analyses",
            "事件分析文件版本或素材标识无效",
        )
    if any(
        analysis.status == "valid"
        and not _event_analysis_target_is_current(
            analysis,
            markers_by_id,
            focus_selection,
        )
        for analysis in event_analyses
    ):
        _raise_issue(
            asset_id,
            event_analyses_path,
            assets_root.parent,
            "stale_event_analysis_source",
            "有效事件分析的目标快照与当前范围标记或焦点选区不一致",
        )

    documents, media = _load_summary(
        asset_directory, asset_id, assets_root.parent, tracked_paths
    )
    digest = _business_digest(asset_directory, tracked_paths)
    return AssetFileBundle(
        asset=asset,
        transcript=transcript,
        segments=segments,
        markers=markers,
        focus_selection=focus_selection,
        event_analyses=event_analyses,
        summary_documents=documents,
        summary_media=media,
        digest=digest,
    )


def _event_analysis_target_is_current(
    analysis: EventAnalysis,
    markers_by_id: dict[str, MediaMarker],
    focus_selection: FocusSelection | None,
) -> bool:
    target = analysis.target
    if target.source == "marker":
        marker = markers_by_id.get(target.marker_id)
        return (
            marker is not None
            and marker.end_seconds is not None
            and marker.start_seconds == target.start_seconds
            and marker.end_seconds == target.end_seconds
        )
    return (
        focus_selection is not None
        and focus_selection.selection_id == target.selection_id
        and focus_selection.in_seconds == target.start_seconds
        and focus_selection.out_seconds == target.end_seconds
    )


def _load_summary(
    asset_directory: Path,
    asset_id: str,
    library_root: Path,
    tracked_paths: list[Path],
) -> tuple[list[SummaryDocument], list[SummaryMediaArtifact]]:
    manifest_path = (
        asset_directory / SUMMARY_DIRECTORY_NAME / SUMMARY_MANIFEST_FILE_NAME
    )
    if not manifest_path.exists():
        tracked_paths.append(manifest_path)
        return [], []
    tracked_paths.append(manifest_path)
    try:
        manifest = load_summary_manifest(asset_directory)
    except (OSError, ValueError):
        _raise_issue(
            asset_id,
            manifest_path,
            library_root,
            "invalid_summary_manifest",
            "总结 manifest 无效或无法读取",
        )
    if manifest.asset_id != asset_id:
        _raise_issue(
            asset_id,
            manifest_path,
            library_root,
            "cross_asset_reference",
            "总结 manifest 不属于当前素材",
        )
    documents: list[SummaryDocument] = []
    media: list[SummaryMediaArtifact] = []
    document_ids = {item.document_id for item in manifest.documents}
    if (
        len(document_ids) != len(manifest.documents)
        or manifest.root_document_id not in document_ids
    ):
        _raise_issue(
            asset_id,
            manifest_path,
            library_root,
            "invalid_summary_manifest",
            "总结文档标识重复或缺少主文档",
        )
    tree_documents = [
        SummaryDocument(**item.model_dump(), asset_id=asset_id, markdown="")
        for item in manifest.documents
    ]
    try:
        summary_document_depths(tree_documents)
        root_document = next(
            item for item in tree_documents if item.parent_document_id is None
        )
        if root_document.document_id != manifest.root_document_id:
            raise ValueError("主文档标识与文档树不一致")
    except ValueError:
        _raise_issue(
            asset_id,
            manifest_path,
            library_root,
            "invalid_summary_manifest",
            "总结文档树无效或超过三级",
        )
    for item in manifest.documents:
        document = SummaryDocument(
            **item.model_dump(),
            asset_id=asset_id,
            markdown="",
        )
        if item.relative_path != document_relative_path(document):
            _raise_issue(
                asset_id,
                manifest_path,
                library_root,
                "unsafe_path",
                "总结文档路径不符合固定契约",
            )
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
            document.model_copy(
                update={
                    "markdown": markdown,
                    "content_digest": digest,
                    "revision": revision,
                }
            )
        )
    expected_media_prefix = f"{SUMMARY_DIRECTORY_NAME}/assets/"
    for artifact in manifest.media:
        if (
            artifact.asset_id != asset_id
            or artifact.document_id not in document_ids
            or not artifact.relative_path.startswith(expected_media_prefix)
        ):
            _raise_issue(
                asset_id,
                manifest_path,
                library_root,
                "cross_asset_reference",
                "总结媒体引用了其他素材或文档",
            )
        _validate_asset_reference(
            asset_directory,
            artifact.relative_path,
            asset_id,
            library_root,
            require_file=True,
        )
        tracked_paths.append(asset_directory / artifact.relative_path)
        media.append(artifact)
    return documents, media


def _read_optional_asset_model(
    path: Path,
    model_type: type[AssetModel],
    asset_id: str,
    tracked_paths: list[Path],
    library_root: Path,
) -> AssetModel | None:
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
    return model


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
        _raise_issue(
            asset_id, path, library_root, "unsafe_path", "业务文件不能是符号链接"
        )
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
        _raise_issue(
            asset_id,
            asset_directory / relative_path,
            library_root,
            "unsafe_path",
            "素材相对路径无效",
        )
    resolved_root = asset_directory.resolve()
    candidate = resolved_root.joinpath(*relative.parts)
    if not candidate.resolve().is_relative_to(resolved_root):
        _raise_issue(
            asset_id, candidate, library_root, "unsafe_path", "素材路径超出当前素材目录"
        )
    current = resolved_root
    for part in relative.parts:
        current /= part
        if current.exists() and current.is_symlink():
            _raise_issue(
                asset_id,
                current,
                library_root,
                "unsafe_path",
                "素材路径不能经过符号链接",
            )
    if require_file and not candidate.is_file():
        _raise_issue(
            asset_id,
            candidate,
            library_root,
            "missing_file",
            "业务文件引用的媒体不存在",
        )


def _business_digest(asset_directory: Path, tracked_paths: list[Path]) -> str:
    digest = hashlib.sha256()
    unique_paths = sorted(
        set(tracked_paths),
        key=lambda path: path.relative_to(asset_directory).as_posix(),
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
