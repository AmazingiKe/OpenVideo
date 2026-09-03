import shutil
from pathlib import Path
from typing import BinaryIO
from urllib.parse import quote

from PIL import Image, UnidentifiedImageError

from openvideo.core.folder_models import (
    FOLDER_NAME_MAX_LENGTH,
    folder_name_from_source_title,
)
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import (
    MediaAsset,
    MediaAssetStatus,
    MediaType,
    SourcePlatform,
)
from openvideo.settings import Settings
from openvideo.tools.media import probe_media, resolve_tool


SUPPORTED_VIDEO_FILE_EXTENSIONS = frozenset(
    {".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"}
)
SUPPORTED_IMAGE_FILE_EXTENSIONS = frozenset(
    {".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"}
)
LOCAL_MEDIA_FILE_STEM = "source"
FILE_COPY_CHUNK_SIZE = 1024 * 1024


class LocalMediaImportError(ValueError):
    pass


def persist_local_media(
    library: MediaLibrary,
    settings: Settings,
    source: BinaryIO,
    filename: str | None,
    folder_id: str | None = None,
) -> MediaAsset:
    """浏览器拖入不能暴露原始路径，因此复制媒体内容并仅保留安全显示名。"""

    original_filename = _normalized_filename(filename)
    extension = Path(original_filename).suffix.lower()
    media_type = _media_type_for_extension(extension)
    asset_id = str(uuid7())
    asset_directory = library.asset_directory(asset_id)
    media_directory = library.media_directory(asset_id)
    media_file = media_directory / f"{LOCAL_MEDIA_FILE_STEM}{extension}"
    try:
        copied_size = _copy_file(source, media_file)
        if copied_size == 0:
            raise LocalMediaImportError("不能导入空的媒体文件")
        asset = (
            _image_asset(
                asset_id,
                asset_directory,
                media_file,
                original_filename,
                folder_id,
            )
            if media_type == MediaType.IMAGE
            else _video_asset(
                asset_id,
                asset_directory,
                media_file,
                original_filename,
                settings,
                folder_id,
            )
        )
        library.save(asset)
        return asset
    except Exception:
        if asset_directory.is_dir():
            shutil.rmtree(asset_directory, ignore_errors=True)
        raise


def _video_asset(
    asset_id: str,
    asset_directory: Path,
    media_file: Path,
    original_filename: str,
    settings: Settings,
    folder_id: str | None,
) -> MediaAsset:
    probe = probe_media(
        media_file,
        settings.ffprobe_path,
        settings.ffmpeg_bin_dir,
    )
    ffprobe_path = resolve_tool(
        settings.ffprobe_path,
        "ffprobe",
        settings.ffmpeg_bin_dir,
    )
    if ffprobe_path and probe.video_codec is None:
        raise LocalMediaImportError("文件中没有可识别的视频轨道")
    return MediaAsset(
        asset_id=asset_id,
        folder_id=folder_id,
        media_type=MediaType.VIDEO,
        source_url=f"local://{quote(original_filename)}",
        source_platform=SourcePlatform.LOCAL,
        title=Path(original_filename).stem.strip() or "本地视频",
        duration_seconds=probe.duration_seconds,
        width=probe.width,
        height=probe.height,
        video_codec=probe.video_codec,
        audio_codec=probe.audio_codec,
        playback_path=media_file.relative_to(asset_directory).as_posix(),
        status=MediaAssetStatus.READY,
    )


def _image_asset(
    asset_id: str,
    asset_directory: Path,
    media_file: Path,
    original_filename: str,
    folder_id: str | None,
) -> MediaAsset:
    try:
        with Image.open(media_file) as image:
            width, height = image.size
            image.verify()
    except (OSError, UnidentifiedImageError) as error:
        raise LocalMediaImportError("图片文件无法识别或已经损坏") from error
    relative_path = media_file.relative_to(asset_directory).as_posix()
    return MediaAsset(
        asset_id=asset_id,
        folder_id=folder_id,
        media_type=MediaType.IMAGE,
        source_url=f"local://{quote(original_filename)}",
        source_platform=SourcePlatform.LOCAL,
        title=Path(original_filename).stem.strip() or "本地图片",
        width=width,
        height=height,
        playback_path=relative_path,
        thumbnail_path=relative_path,
        status=MediaAssetStatus.READY,
    )


def _normalized_filename(filename: str | None) -> str:
    normalized = (filename or "").replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not normalized:
        raise LocalMediaImportError("媒体文件名不能为空")
    return normalized


def _media_type_for_extension(extension: str) -> MediaType:
    if extension in SUPPORTED_VIDEO_FILE_EXTENSIONS:
        return MediaType.VIDEO
    if extension in SUPPORTED_IMAGE_FILE_EXTENSIONS:
        return MediaType.IMAGE
    raise LocalMediaImportError(
        "仅支持 AVI、BMP、GIF、JPEG、JPG、M4V、MKV、MOV、MP4、PNG、WebM 和 WebP 文件"
    )


def _copy_file(source: BinaryIO, destination: Path) -> int:
    copied_size = 0
    with destination.open("xb") as output:
        while chunk := source.read(FILE_COPY_CHUNK_SIZE):
            output.write(chunk)
            copied_size += len(chunk)
    return copied_size


def import_video_directory(
    library: MediaLibrary,
    settings: Settings,
    source_directory: Path,
    *,
    include_subfolders: bool,
) -> tuple[list[MediaAsset], list[str]]:
    """目录导入用虚拟文件夹镜像来源层级，避免复制后的业务结构依赖原始路径。"""

    resolved_directory = source_directory.resolve()
    if (
        source_directory.is_symlink()
        or not resolved_directory.is_dir()
        or resolved_directory == library.library_path
        or resolved_directory.is_relative_to(library.library_path)
        or library.library_path.is_relative_to(resolved_directory)
    ):
        raise LocalMediaImportError("请选择资料库之外的有效文件夹")

    candidates = (
        resolved_directory.rglob("*")
        if include_subfolders
        else resolved_directory.iterdir()
    )
    video_files = sorted(
        (
            path
            for path in candidates
            if path.is_file()
            and not path.is_symlink()
            and path.suffix.lower() in SUPPORTED_VIDEO_FILE_EXTENSIONS
        ),
        key=lambda path: path.relative_to(resolved_directory).as_posix().casefold(),
    )
    if not video_files:
        raise LocalMediaImportError("所选文件夹中没有可导入的视频")

    root_folder = library.create_folder(
        _available_folder_name(library, resolved_directory.name, None)
    )
    folder_ids = {Path("."): root_folder.folder_id}
    directory_paths = {Path(".")}
    for video_file in video_files:
        relative_directory = video_file.relative_to(resolved_directory).parent
        while relative_directory != Path("."):
            directory_paths.add(relative_directory)
            relative_directory = relative_directory.parent
    relative_directories = sorted(
        directory_paths,
        key=lambda path: (len(path.parts), path.as_posix().casefold()),
    )
    for relative_directory in relative_directories:
        if relative_directory == Path("."):
            continue
        parent_id = folder_ids[relative_directory.parent]
        folder = library.create_folder(
            _available_folder_name(
                library,
                relative_directory.name,
                parent_id,
            ),
            parent_id,
        )
        folder_ids[relative_directory] = folder.folder_id

    imported_assets: list[MediaAsset] = []
    failed_files: list[str] = []
    for video_file in video_files:
        relative_path = video_file.relative_to(resolved_directory)
        try:
            with video_file.open("rb") as source:
                imported_assets.append(
                    persist_local_media(
                        library,
                        settings,
                        source,
                        video_file.name,
                        folder_ids[relative_path.parent],
                    )
                )
        except (LocalMediaImportError, OSError) as error:
            failed_files.append(f"{relative_path.as_posix()}：{error}")
    return imported_assets, failed_files


def _available_folder_name(
    library: MediaLibrary,
    requested_name: str,
    parent_id: str | None,
) -> str:
    normalized_name = folder_name_from_source_title(requested_name) or "导入的视频"
    sibling_names = {
        folder.name
        for folder in library.list_folders()
        if folder.parent_id == parent_id
    }
    if normalized_name not in sibling_names:
        return normalized_name
    suffix_number = 2
    while True:
        suffix = f" ({suffix_number})"
        available_length = FOLDER_NAME_MAX_LENGTH - len(suffix)
        candidate_name = f"{normalized_name[:available_length].rstrip()}{suffix}"
        if candidate_name not in sibling_names:
            return candidate_name
        suffix_number += 1
