import shutil
from pathlib import Path
from typing import BinaryIO
from urllib.parse import quote

from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import MediaAsset, MediaAssetStatus, SourcePlatform
from openvideo.settings import Settings
from openvideo.tools.media import probe_media, resolve_tool


SUPPORTED_VIDEO_FILE_EXTENSIONS = frozenset(
    {".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"}
)
LOCAL_VIDEO_FILE_STEM = "source"
FILE_COPY_CHUNK_SIZE = 1024 * 1024


class LocalVideoImportError(ValueError):
    pass


def persist_local_video(
    library: MediaLibrary,
    settings: Settings,
    source: BinaryIO,
    filename: str | None,
) -> MediaAsset:
    """浏览器上传不能暴露原始本地路径，因此只保留显示名并把内容写入受控素材目录。"""

    original_filename = _normalized_filename(filename)
    extension = Path(original_filename).suffix.lower()
    if extension not in SUPPORTED_VIDEO_FILE_EXTENSIONS:
        raise LocalVideoImportError("仅支持 AVI、M4V、MKV、MOV、MP4 和 WebM 视频文件")

    asset_id = str(uuid7())
    asset_directory = library.asset_directory(asset_id)
    media_directory = library.media_directory(asset_id)
    playback_file = media_directory / f"{LOCAL_VIDEO_FILE_STEM}{extension}"
    try:
        copied_size = _copy_file(source, playback_file)
        if copied_size == 0:
            raise LocalVideoImportError("不能导入空的视频文件")

        probe = probe_media(
            playback_file,
            settings.ffprobe_path,
            settings.ffmpeg_bin_dir,
        )
        ffprobe_path = resolve_tool(
            settings.ffprobe_path,
            "ffprobe",
            settings.ffmpeg_bin_dir,
        )
        if ffprobe_path and probe.video_codec is None:
            raise LocalVideoImportError("文件中没有可识别的视频轨道")

        asset = MediaAsset(
            asset_id=asset_id,
            source_url=f"local://{quote(original_filename)}",
            source_platform=SourcePlatform.LOCAL,
            title=Path(original_filename).stem.strip() or "本地视频",
            duration_seconds=probe.duration_seconds,
            width=probe.width,
            height=probe.height,
            video_codec=probe.video_codec,
            audio_codec=probe.audio_codec,
            playback_path=playback_file.relative_to(asset_directory).as_posix(),
            status=MediaAssetStatus.READY,
        )
        library.save(asset)
        return asset
    except Exception:
        if asset_directory.is_dir():
            shutil.rmtree(asset_directory, ignore_errors=True)
        raise


def _normalized_filename(filename: str | None) -> str:
    normalized = (filename or "").replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not normalized:
        raise LocalVideoImportError("视频文件名不能为空")
    return normalized


def _copy_file(source: BinaryIO, destination: Path) -> int:
    copied_size = 0
    with destination.open("xb") as output:
        while chunk := source.read(FILE_COPY_CHUNK_SIZE):
            output.write(chunk)
            copied_size += len(chunk)
    return copied_size
