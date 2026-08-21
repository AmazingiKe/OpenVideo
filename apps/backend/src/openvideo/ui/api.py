from collections.abc import Iterator
from contextlib import asynccontextmanager
from pathlib import Path
import asyncio

from fastapi import FastAPI, Header, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from openvideo.application import AnalysisError, AnalysisManager, DownloadManager
from openvideo.core.analysis_models import AnalysisJob, AnalysisMode, Transcript
from openvideo.core.byte_range import InvalidByteRange, parse_byte_range
from openvideo.core.library import MediaLibrary
from openvideo.core.identifiers import uuid7
from openvideo.core.models import (
    DownloadJob,
    MediaAssetResponse,
    MediaAssetStatus,
    MediaMarker,
    MediaSegment,
    SourcePlatform,
)
from openvideo.settings import Settings, load_settings
from openvideo.tools.downloader import (
    DownloadFailure,
    PlaylistProbe,
    probe_source,
    yt_dlp_available,
)
from openvideo.tools.media import media_tool_status
from openvideo.tools.sources import UnsupportedSourceError, resolve_source


STREAM_CHUNK_SIZE = 1024 * 1024
VIDEO_MEDIA_TYPE = "video/mp4"
MAX_BATCH_DOWNLOADS = 100


class DependencyStatus(BaseModel):
    yt_dlp: bool
    ffmpeg: bool
    ffprobe: bool


class HealthResponse(BaseModel):
    status: str
    dependencies: DependencyStatus


class ProbeRequest(BaseModel):
    source_url: str


class ProbeEntry(BaseModel):
    source_video_id: str
    url: str
    title: str | None
    duration_seconds: float | None
    uploader: str | None


class ProbeResponse(BaseModel):
    platform: SourcePlatform
    is_playlist: bool
    title: str | None
    entries: list[ProbeEntry]
    truncated: bool
    total_count: int


class BatchDownloadRequest(BaseModel):
    source_urls: list[str]


class MarkerCreateRequest(BaseModel):
    time_seconds: float = Field(ge=0)
    tags: list[str] = Field(default_factory=list)


class MarkerUpdateRequest(BaseModel):
    tags: list[str]


class AnalysisCreateRequest(BaseModel):
    mode: AnalysisMode = AnalysisMode.FULL
    marker_ids: list[str] = Field(default_factory=list)
    force: bool = False


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved_settings = settings or load_settings()
    library = MediaLibrary(resolved_settings.library_path)
    manager = DownloadManager(library, resolved_settings)
    analysis_manager = AnalysisManager(library, resolved_settings)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        library.load()
        analysis_manager.restore()
        yield

    app = FastAPI(title="OpenVideo API", version="0.1.0", lifespan=lifespan)
    app.state.library = library
    app.state.download_manager = manager
    app.state.analysis_manager = analysis_manager
    app.state.settings = resolved_settings
    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved_settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "HEAD"],
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

    @app.post("/api/downloads/probe", response_model=ProbeResponse)
    async def probe_download(request: ProbeRequest) -> ProbeResponse:
        try:
            match = resolve_source(request.source_url)
        except UnsupportedSourceError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        probe_target = match.playlist_url or match.normalized_url
        try:
            probe = await asyncio.to_thread(
                probe_source,
                probe_target,
                match.platform,
                match.source_video_id,
            )
        except DownloadFailure as error:
            raise HTTPException(status_code=502, detail=str(error) or "无法读取视频信息") from error
        return _probe_response(match.platform, probe)

    @app.post(
        "/api/downloads",
        response_model=list[DownloadJob],
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def create_downloads(request: BatchDownloadRequest) -> list[DownloadJob]:
        if not request.source_urls:
            raise HTTPException(status_code=422, detail="请至少提供一个视频地址")
        if len(request.source_urls) > MAX_BATCH_DOWNLOADS:
            raise HTTPException(
                status_code=422,
                detail=f"单次最多下载 {MAX_BATCH_DOWNLOADS} 个视频",
            )
        matches = []
        for source_url in request.source_urls:
            try:
                matches.append(resolve_source(source_url))
            except UnsupportedSourceError as error:
                raise HTTPException(status_code=422, detail=str(error)) from error
        jobs = manager.create_batch(matches)
        for job in jobs:
            if job.stage.value != "complete":
                manager.start(job.job_id)
        return jobs

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

    @app.post(
        "/api/media/assets/{asset_id}/analyze",
        response_model=AnalysisJob,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def analyze_asset(
        asset_id: str,
        request: AnalysisCreateRequest = AnalysisCreateRequest(),
    ) -> AnalysisJob:
        try:
            job = analysis_manager.create(
                asset_id,
                request.mode,
                request.marker_ids,
                request.force,
            )
        except AnalysisError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        if job.stage.value != "complete":
            analysis_manager.start(job.job_id)
        return job

    @app.get("/api/analysis/{job_id}", response_model=AnalysisJob)
    def get_analysis(job_id: str) -> AnalysisJob:
        job = analysis_manager.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="分析任务不存在")
        return job

    @app.get(
        "/api/media/assets/{asset_id}/transcript",
        response_model=Transcript,
    )
    def get_transcript(asset_id: str) -> Transcript:
        transcript = analysis_manager.transcript(asset_id)
        if not transcript:
            raise HTTPException(status_code=404, detail="该视频还没有转写结果")
        return transcript

    @app.get(
        "/api/media/assets/{asset_id}/segments",
        response_model=list[MediaSegment],
    )
    def get_segments(asset_id: str) -> list[MediaSegment]:
        return analysis_manager.segments(asset_id)

    @app.get(
        "/api/media/assets/{asset_id}/markers",
        response_model=list[MediaMarker],
    )
    def get_markers(asset_id: str) -> list[MediaMarker]:
        _ready_asset(library, asset_id)
        return library.load_markers(asset_id)

    @app.post(
        "/api/media/assets/{asset_id}/markers",
        response_model=MediaMarker,
        status_code=status.HTTP_201_CREATED,
    )
    def create_marker(asset_id: str, request: MarkerCreateRequest) -> MediaMarker:
        _ready_asset(library, asset_id)
        marker = MediaMarker(
            marker_id=f"marker-{uuid7().hex}",
            asset_id=asset_id,
            time_seconds=request.time_seconds,
            tags=request.tags,
        )
        return library.create_marker(marker)

    @app.patch(
        "/api/media/assets/{asset_id}/markers/{marker_id}",
        response_model=MediaMarker,
    )
    def update_marker(
        asset_id: str,
        marker_id: str,
        request: MarkerUpdateRequest,
    ) -> MediaMarker:
        _ready_asset(library, asset_id)
        try:
            marker = library.update_marker_tags(asset_id, marker_id, request.tags)
        except ValueError as error:
            raise HTTPException(status_code=404, detail="标记不存在") from error
        if marker is None:
            raise HTTPException(status_code=404, detail="标记不存在")
        return marker

    @app.delete(
        "/api/media/assets/{asset_id}/markers/{marker_id}",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    def delete_marker(asset_id: str, marker_id: str) -> Response:
        _ready_asset(library, asset_id)
        try:
            deleted = library.delete_marker(asset_id, marker_id)
        except ValueError as error:
            raise HTTPException(status_code=404, detail="标记不存在") from error
        if not deleted:
            raise HTTPException(status_code=404, detail="标记不存在")
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @app.get("/api/media/assets/{asset_id}/frames/{frame_path:path}")
    def get_frame(asset_id: str, frame_path: str) -> FileResponse:
        asset = _ready_asset(library, asset_id)
        frame_file = library.resolve_asset_file(asset, frame_path)
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


def _probe_response(platform: SourcePlatform, probe: PlaylistProbe) -> ProbeResponse:
    return ProbeResponse(
        platform=platform,
        is_playlist=probe.is_playlist,
        title=probe.title,
        entries=[
            ProbeEntry(
                source_video_id=entry.source_video_id,
                url=_entry_download_url(platform, entry.source_video_id, entry.url),
                title=entry.title,
                duration_seconds=entry.duration_seconds,
                uploader=entry.uploader,
            )
            for entry in probe.entries
        ],
        truncated=probe.truncated,
        total_count=probe.total_count,
    )


def _entry_download_url(platform: SourcePlatform, video_id: str, raw_url: str) -> str:
    """把浅层条目补全成 resolve_source 能识别的规范单视频地址。

    yt-dlp 的 --flat-playlist 对不同平台返回完整 URL 或裸 ID，统一按平台重建，
    确保批量下载端点里的每个地址都能通过来源校验。
    """
    if platform == SourcePlatform.BILIBILI:
        return f"https://www.bilibili.com/video/{video_id}"
    if platform == SourcePlatform.DOUYIN:
        return f"https://www.douyin.com/video/{video_id}"
    if platform == SourcePlatform.YOUTUBE:
        return f"https://www.youtube.com/watch?v={video_id}"
    return raw_url


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
