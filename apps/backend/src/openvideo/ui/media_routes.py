import asyncio
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request, Response, status
from fastapi.responses import FileResponse, StreamingResponse

from openvideo.core.byte_range import InvalidByteRange, parse_byte_range
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import (
    MediaAssetStatus,
    MediaType,
    SubtitleDisplaySettings,
    SubtitleExportResult,
    ThumbnailStoryboardResponse,
)
from openvideo.settings import Settings
from openvideo.tools.subtitle_export import (
    SubtitleExportError,
    SubtitleExportUnavailableError,
    export_subtitled_video,
)
from openvideo.tools.thumbnails import generate_thumbnail_sprite

STREAM_CHUNK_SIZE = 1024 * 1024
DEFAULT_VIDEO_MEDIA_TYPE = "video/mp4"
VIDEO_MEDIA_TYPES = {
    ".avi": "video/x-msvideo",
    ".m4v": "video/mp4",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
}
SUBTITLE_EXPORTS_DIRECTORY_NAME = "subtitle-exports"


def register_media_routes(
    app: FastAPI,
    library: Callable[[], MediaLibrary],
    settings: Settings,
) -> None:
    storyboard_locks: dict[str, asyncio.Lock] = {}

    @app.patch(
        "/api/media/assets/{asset_id}/subtitle-settings",
        response_model=SubtitleDisplaySettings,
    )
    def update_subtitle_settings(
        asset_id: str,
        request: SubtitleDisplaySettings,
    ) -> SubtitleDisplaySettings:
        media_library = library()
        asset = ready_asset(media_library, asset_id)
        if asset.media_type != MediaType.VIDEO:
            raise HTTPException(status_code=422, detail="只有视频支持字幕设置")
        configuration = media_library.load_video_configuration(asset_id)
        updated_configuration = configuration.model_copy(
            update={"subtitle_display": request}
        )
        try:
            media_library.save_video_configuration(updated_configuration)
        except (OSError, ValueError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return request

    @app.post(
        "/api/media/assets/{asset_id}/subtitle-exports",
        response_model=SubtitleExportResult,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_subtitle_export(asset_id: str) -> SubtitleExportResult:
        media_library = library()
        asset = ready_asset(media_library, asset_id)
        if asset.media_type != MediaType.VIDEO:
            raise HTTPException(status_code=422, detail="只有视频支持字幕导出")
        media_file = media_library.resolve_asset_file(asset, asset.playback_path)
        if media_file is None:
            raise HTTPException(status_code=404, detail="视频文件不存在")
        transcript = media_library.load_transcript(asset_id)
        if transcript is None or not any(
            segment.text.strip() for segment in transcript.segments
        ):
            raise HTTPException(status_code=409, detail="当前视频没有可导出的字幕")

        exported_at = datetime.now(UTC)
        export_id = f"export-{uuid7().hex}"
        timestamp = exported_at.strftime("%Y%m%d-%H%M%S")
        file_name = f"subtitled-{timestamp}-{export_id}.mp4"
        export_directory = (
            media_library.artifacts_directory(asset_id)
            / SUBTITLE_EXPORTS_DIRECTORY_NAME
        )
        if export_directory.exists() and export_directory.is_symlink():
            raise HTTPException(status_code=409, detail="字幕导出目录不能是符号链接")
        output_path = export_directory / file_name
        settings_value = media_library.load_video_configuration(
            asset_id
        ).subtitle_display
        try:
            await asyncio.to_thread(
                export_subtitled_video,
                media_file,
                transcript.segments,
                settings_value,
                output_path,
                settings.ffmpeg_path,
                settings.ffmpeg_bin_dir,
            )
        except SubtitleExportUnavailableError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except SubtitleExportError as error:
            raise HTTPException(status_code=500, detail=str(error)) from error
        except OSError as error:
            raise HTTPException(
                status_code=500, detail="字幕导出文件保存失败"
            ) from error
        return SubtitleExportResult(
            export_id=export_id,
            relative_path=output_path.relative_to(
                media_library.library_path
            ).as_posix(),
            file_name=file_name,
            size_bytes=output_path.stat().st_size,
            exported_at=exported_at,
        )

    @app.get("/api/media/assets/{asset_id}/frames/{frame_path:path}")
    def get_frame(asset_id: str, frame_path: str) -> FileResponse:
        asset = ready_asset(library(), asset_id)
        frame_file = library().resolve_asset_file(asset, frame_path)
        if not frame_file:
            raise HTTPException(status_code=404, detail="关键帧不存在")
        return FileResponse(frame_file, media_type="image/jpeg")

    @app.api_route(
        "/api/media/assets/{asset_id}/stream",
        methods=["GET", "HEAD"],
    )
    def stream_asset(
        request: Request,
        asset_id: str,
        range_header: str | None = Header(default=None, alias="Range"),
    ) -> Response:
        asset = ready_asset(library(), asset_id)
        media_file = library().resolve_asset_file(asset, asset.playback_path)
        if not media_file:
            raise HTTPException(status_code=404, detail="视频文件不存在")
        return stream_video_file(request, media_file, range_header)

    @app.get("/api/media/assets/{asset_id}/thumbnail")
    def thumbnail(asset_id: str) -> FileResponse:
        asset = ready_asset(library(), asset_id)
        thumbnail_file = library().resolve_asset_file(asset, asset.thumbnail_path)
        if not thumbnail_file:
            raise HTTPException(status_code=404, detail="视频封面不存在")
        return FileResponse(thumbnail_file)

    @app.post(
        "/api/media/assets/{asset_id}/thumbnail-storyboard",
        response_model=ThumbnailStoryboardResponse,
    )
    async def ensure_thumbnail_storyboard(
        asset_id: str,
    ) -> ThumbnailStoryboardResponse:
        media_library = library()
        asset = ready_asset(media_library, asset_id)
        if asset.media_type != MediaType.VIDEO:
            raise HTTPException(status_code=422, detail="只有视频支持拖动预览")
        existing_storyboard = media_library.response_for(asset).thumbnail_storyboard
        if existing_storyboard is not None:
            return existing_storyboard

        generation_lock = storyboard_locks.setdefault(asset_id, asyncio.Lock())
        async with generation_lock:
            asset = ready_asset(media_library, asset_id)
            existing_storyboard = media_library.response_for(
                asset
            ).thumbnail_storyboard
            if existing_storyboard is not None:
                return existing_storyboard
            media_file = media_library.resolve_asset_file(asset, asset.playback_path)
            if media_file is None:
                raise HTTPException(status_code=404, detail="视频文件不存在")
            media_directory = media_library.media_directory(asset.asset_id)
            storyboard = await asyncio.to_thread(
                generate_thumbnail_sprite,
                media_file,
                media_directory,
                asset.duration_seconds,
                asset.width,
                asset.height,
                settings.ffmpeg_path,
                settings.ffmpeg_bin_dir,
            )
            if storyboard is None:
                raise HTTPException(
                    status_code=503,
                    detail="拖动预览图暂时无法生成",
                )
            sprite_file = media_directory / storyboard.sprite_path
            asset.thumbnail_sprite_path = (
                sprite_file.relative_to(
                    media_library.asset_directory(asset.asset_id)
                ).as_posix()
            )
            asset.thumbnail_tile_width = storyboard.tile_width
            asset.thumbnail_tile_height = storyboard.tile_height
            asset.thumbnail_interval_seconds = storyboard.interval_seconds
            asset.thumbnail_columns = storyboard.columns
            asset.thumbnail_total_tiles = storyboard.total_tiles
            media_library.save(asset)
            response = media_library.response_for(asset).thumbnail_storyboard
            if response is None:
                raise HTTPException(status_code=500, detail="拖动预览图保存失败")
            return response

    @app.get("/api/media/assets/{asset_id}/thumbnail-sprite")
    def thumbnail_sprite(asset_id: str) -> FileResponse:
        asset = ready_asset(library(), asset_id)
        sprite_file = library().resolve_asset_file(asset, asset.thumbnail_sprite_path)
        if not sprite_file:
            raise HTTPException(status_code=404, detail="预览图拼板不存在")
        return FileResponse(sprite_file, media_type="image/jpeg")


def ready_asset(library: MediaLibrary, asset_id: str):
    try:
        asset = library.get(asset_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail="媒体资源不存在") from error
    if not asset or asset.status != MediaAssetStatus.READY:
        raise HTTPException(status_code=404, detail="媒体资源不存在")
    return asset


def validate_marker_bounds(
    start_seconds: float,
    end_seconds: float | None,
    duration_seconds: float | None,
) -> None:
    if end_seconds is not None and end_seconds <= start_seconds:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="范围标记的结束时间必须晚于开始时间",
        )
    if duration_seconds is not None and (
        start_seconds > duration_seconds
        or (end_seconds is not None and end_seconds > duration_seconds)
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="标记时间必须位于视频时长内",
        )


def _read_file_range(file_path: Path, start: int, length: int) -> Iterator[bytes]:
    remaining = length
    with file_path.open("rb") as media_file:
        media_file.seek(start)
        while remaining > 0:
            chunk = media_file.read(min(STREAM_CHUNK_SIZE, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def stream_video_file(
    request: Request,
    media_file: Path,
    range_header: str | None,
) -> Response:
    total_size = media_file.stat().st_size
    media_type = VIDEO_MEDIA_TYPES.get(
        media_file.suffix.lower(), DEFAULT_VIDEO_MEDIA_TYPE
    )
    common_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=0",
    }
    if range_header:
        try:
            byte_range = parse_byte_range(range_header, total_size)
        except InvalidByteRange:
            return Response(
                status_code=status.HTTP_416_RANGE_NOT_SATISFIABLE,
                headers={
                    **common_headers,
                    "Content-Range": f"bytes */{total_size}",
                },
            )
        headers = {
            **common_headers,
            "Content-Range": byte_range.content_range,
            "Content-Length": str(byte_range.length),
        }
        if request.method == "HEAD":
            return Response(
                status_code=206,
                media_type=media_type,
                headers=headers,
            )
        return StreamingResponse(
            _read_file_range(media_file, byte_range.start, byte_range.length),
            status_code=206,
            media_type=media_type,
            headers=headers,
        )
    headers = {**common_headers, "Content-Length": str(total_size)}
    if request.method == "HEAD":
        return Response(status_code=200, media_type=media_type, headers=headers)
    return StreamingResponse(
        _read_file_range(media_file, 0, total_size),
        status_code=200,
        media_type=media_type,
        headers=headers,
    )
