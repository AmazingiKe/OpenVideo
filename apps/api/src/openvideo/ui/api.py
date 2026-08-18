from collections.abc import Iterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from openvideo.application import DownloadManager
from openvideo.core.byte_range import InvalidByteRange, parse_byte_range
from openvideo.core.library import MediaLibrary
from openvideo.core.models import DownloadJob, DownloadRequest, MediaAssetResponse, MediaAssetStatus
from openvideo.settings import Settings, load_settings
from openvideo.tools.bilibili import InvalidBilibiliUrl, validate_bilibili_url
from openvideo.tools.downloader import yt_dlp_available
from openvideo.tools.media import media_tool_status


STREAM_CHUNK_SIZE = 1024 * 1024
VIDEO_MEDIA_TYPE = "video/mp4"


class DependencyStatus(BaseModel):
    yt_dlp: bool
    ffmpeg: bool
    ffprobe: bool


class HealthResponse(BaseModel):
    status: str
    dependencies: DependencyStatus


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved_settings = settings or load_settings()
    library = MediaLibrary(resolved_settings.library_path)
    manager = DownloadManager(library, resolved_settings)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        library.load()
        yield

    app = FastAPI(title="OpenVideo API", version="0.1.0", lifespan=lifespan)
    app.state.library = library
    app.state.download_manager = manager
    app.state.settings = resolved_settings
    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved_settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "HEAD"],
        allow_headers=["Content-Type", "Range"],
    )

    @app.get("/api/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        tools = media_tool_status(
            resolved_settings.ffmpeg_path,
            resolved_settings.ffprobe_path,
            resolved_settings.ffmpeg_bin_dir,
        )
        dependencies = DependencyStatus(
            yt_dlp=yt_dlp_available(),
            ffmpeg=tools.ffmpeg_available,
            ffprobe=tools.ffprobe_available,
        )
        service_status = "ready" if dependencies.yt_dlp and dependencies.ffmpeg else "degraded"
        return HealthResponse(status=service_status, dependencies=dependencies)

    @app.post(
        "/api/downloads",
        response_model=DownloadJob,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def create_download(request: DownloadRequest) -> DownloadJob:
        try:
            source = validate_bilibili_url(request.source_url)
        except InvalidBilibiliUrl as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        job = manager.create(source)
        if job.stage.value != "complete":
            manager.start(job.job_id)
        return job

    @app.get("/api/downloads/{job_id}", response_model=DownloadJob)
    def get_download(job_id: str) -> DownloadJob:
        job = manager.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="下载任务不存在")
        return job

    @app.get("/api/media/assets", response_model=list[MediaAssetResponse])
    def list_assets() -> list[MediaAssetResponse]:
        return [library.response_for(asset) for asset in library.list()]

    @app.get("/api/media/assets/{asset_id}", response_model=MediaAssetResponse)
    def get_asset(asset_id: str) -> MediaAssetResponse:
        asset = _ready_asset(library, asset_id)
        return library.response_for(asset)

    @app.api_route(
        "/api/media/assets/{asset_id}/stream",
        methods=["GET", "HEAD"],
    )
    def stream_asset(
        request: Request,
        asset_id: str,
        range_header: str | None = Header(default=None, alias="Range"),
    ) -> Response:
        asset = _ready_asset(library, asset_id)
        media_file = library.resolve_asset_file(asset, asset.playback_path)
        if not media_file:
            raise HTTPException(status_code=404, detail="视频文件不存在")
        total_size = media_file.stat().st_size
        common_headers = {
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=0",
        }
        if range_header:
            try:
                byte_range = parse_byte_range(range_header, total_size)
            except InvalidByteRange as error:
                return Response(
                    status_code=status.HTTP_416_RANGE_NOT_SATISFIABLE,
                    headers={**common_headers, "Content-Range": f"bytes */{total_size}"},
                )
            headers = {
                **common_headers,
                "Content-Range": byte_range.content_range,
                "Content-Length": str(byte_range.length),
            }
            if request.method == "HEAD":
                return Response(status_code=206, media_type=VIDEO_MEDIA_TYPE, headers=headers)
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

    @app.get("/api/media/assets/{asset_id}/thumbnail")
    def thumbnail(asset_id: str) -> FileResponse:
        asset = _ready_asset(library, asset_id)
        thumbnail_file = library.resolve_asset_file(asset, asset.thumbnail_path)
        if not thumbnail_file:
            raise HTTPException(status_code=404, detail="视频封面不存在")
        return FileResponse(thumbnail_file)

    @app.get("/api/media/assets/{asset_id}/thumbnail-sprite")
    def thumbnail_sprite(asset_id: str) -> FileResponse:
        asset = _ready_asset(library, asset_id)
        sprite_file = library.resolve_asset_file(asset, asset.thumbnail_sprite_path)
        if not sprite_file:
            raise HTTPException(status_code=404, detail="预览图拼板不存在")
        return FileResponse(sprite_file, media_type="image/jpeg")

    return app


def _ready_asset(library: MediaLibrary, asset_id: str):
    try:
        asset = library.get(asset_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail="媒体资源不存在") from error
    if not asset or asset.status != MediaAssetStatus.READY:
        raise HTTPException(status_code=404, detail="媒体资源不存在")
    return asset


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


app = create_app()
