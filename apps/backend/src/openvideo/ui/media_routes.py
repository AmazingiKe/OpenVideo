from collections.abc import Callable, Iterator
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request, Response, status
from fastapi.responses import FileResponse, StreamingResponse

from openvideo.core.byte_range import InvalidByteRange, parse_byte_range
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import MediaAssetStatus
from openvideo.core.thumbnails import SCRUB_PROXY_RELATIVE_PATH
from openvideo.settings import Settings
from openvideo.tools.thumbnails import generate_scrub_proxy

STREAM_CHUNK_SIZE = 1024 * 1024
VIDEO_MEDIA_TYPE = "video/mp4"


def register_media_routes(
    app: FastAPI,
    library: Callable[[], MediaLibrary],
    settings: Settings,
) -> None:
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

    @app.api_route(
        "/api/media/assets/{asset_id}/scrub-preview",
        methods=["GET", "HEAD"],
    )
    def scrub_preview(
        request: Request,
        asset_id: str,
        range_header: str | None = Header(default=None, alias="Range"),
    ) -> Response:
        asset = ready_asset(library(), asset_id)
        preview_file = library().resolve_asset_file(asset, SCRUB_PROXY_RELATIVE_PATH)
        if not preview_file:
            playback_file = library().resolve_asset_file(asset, asset.playback_path)
            if not playback_file:
                raise HTTPException(status_code=404, detail="视频文件不存在")
            generated_file = generate_scrub_proxy(
                playback_file,
                library().media_directory(asset.asset_id),
                settings.ffmpeg_path,
                settings.ffmpeg_bin_dir,
            )
            preview_file = library().resolve_asset_file(
                asset, SCRUB_PROXY_RELATIVE_PATH
            )
            if generated_file is None or not preview_file:
                raise HTTPException(status_code=404, detail="拖动预览视频生成失败")
        return stream_video_file(request, preview_file, range_header)

    @app.get("/api/media/assets/{asset_id}/thumbnail")
    def thumbnail(asset_id: str) -> FileResponse:
        asset = ready_asset(library(), asset_id)
        thumbnail_file = library().resolve_asset_file(asset, asset.thumbnail_path)
        if not thumbnail_file:
            raise HTTPException(status_code=404, detail="视频封面不存在")
        return FileResponse(thumbnail_file)

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
                media_type=VIDEO_MEDIA_TYPE,
                headers=headers,
            )
        return StreamingResponse(
            _read_file_range(media_file, byte_range.start, byte_range.length),
            status_code=206,
            media_type=VIDEO_MEDIA_TYPE,
            headers=headers,
        )
    headers = {**common_headers, "Content-Length": str(total_size)}
    if request.method == "HEAD":
        return Response(status_code=200, media_type=VIDEO_MEDIA_TYPE, headers=headers)
    return StreamingResponse(
        _read_file_range(media_file, 0, total_size),
        status_code=200,
        media_type=VIDEO_MEDIA_TYPE,
        headers=headers,
    )
