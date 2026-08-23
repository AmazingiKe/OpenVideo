from collections.abc import Callable, Iterator
from contextlib import asynccontextmanager
from pathlib import Path
import asyncio
import os

from fastapi import FastAPI, Header, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from openvideo.application import (
    AnalysisError,
    AnalysisManager,
    AnalysisPrerequisiteError,
    DownloadManager,
)
from openvideo.core.ai_models import AiModelCollection
from openvideo.core.analysis_models import (
    AnalysisJob,
    AnalysisMode,
    Transcript,
    TranscriptionOptions,
)
from openvideo.core.byte_range import InvalidByteRange, parse_byte_range
from openvideo.core.library import (
    InvalidLibraryError,
    LibraryDescription,
    LibraryError,
    MediaLibrary,
)
from openvideo.core.identifiers import uuid7
from openvideo.core.models import (
    DownloadJob,
    MediaAssetResponse,
    MediaAssetStatus,
    MediaMarker,
    MediaSegment,
    SourcePlatform,
)
from openvideo.core.page_settings import (
    LEGACY_PAGE_SETTINGS_FILE_NAME,
    AnalysisPageSettings,
    PageSettingsStore,
)
from openvideo.preferences import PreferenceStore
from openvideo.settings import PROJECT_ROOT, Settings, load_settings, preferences_from_settings
from openvideo.tools.downloader import (
    DownloadFailure,
    PlaylistProbe,
    probe_source,
    yt_dlp_available,
)
from openvideo.tools.media import media_tool_status
from openvideo.tools.sources import UnsupportedSourceError, resolve_source
from openvideo.ui.directory_picker import DirectoryPickerError, select_directory


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


class TranscriptSegmentUpdateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=10_000)


class TranscriptCorrectionRequest(BaseModel):
    segment_indices: list[int] | None = None
    ai_model_id: str


class AnalysisCreateRequest(BaseModel):
    mode: AnalysisMode = AnalysisMode.FULL
    marker_ids: list[str] = Field(default_factory=list)
    force: bool = False
    ai_model_id: str | None = None


class TranscriptionCreateRequest(BaseModel):
    force: bool = False
    model: str = "small"
    language: str | None = "zh"
    compute_type: str = "int8"


class LibraryCreateRequest(BaseModel):
    path: str


class LibraryOpenRequest(BaseModel):
    path: str


class DirectorySelectionResponse(BaseModel):
    path: str | None


class PreferencesPatch(AiModelCollection):
    tools_directory: str | None = None
    models_directory: str | None = None


class PreferencesResponse(AiModelCollection):
    tools_directory: str | None
    models_directory: str | None
    managed_fields: list[str]
    library_path_managed: bool


class AiModelSummary(BaseModel):
    model_id: str
    name: str
    litellm_model: str
    supports_vision: bool


def create_app(
    settings: Settings | None = None,
    preference_store: PreferenceStore | None = None,
    directory_picker: Callable[[], str | None] | None = None,
) -> FastAPI:
    preference_store = preference_store or PreferenceStore()
    resolved_settings = settings or load_settings(preference_store)
    library: MediaLibrary | None = None
    manager: DownloadManager | None = None
    analysis_manager: AnalysisManager | None = None
    page_settings_store: PageSettingsStore | None = None
    pick_directory = directory_picker or select_directory
    directory_picker_lock = asyncio.Lock()

    async def install_library(opened_library: MediaLibrary) -> None:
        nonlocal library, manager, analysis_manager, page_settings_store
        library = opened_library
        manager = DownloadManager(opened_library, resolved_settings)
        analysis_manager = AnalysisManager(opened_library, resolved_settings)
        page_settings_store = PageSettingsStore(
            preference_store.path.parent,
            opened_library.manifest.library_id,
            opened_library.library_path / LEGACY_PAGE_SETTINGS_FILE_NAME,
        )
        analysis_manager.restore()
        app.state.library = opened_library
        app.state.download_manager = manager
        app.state.analysis_manager = analysis_manager
        app.state.page_settings_store = page_settings_store

    def require_library() -> MediaLibrary:
        if library is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": "library_not_open", "message": "尚未打开资料库"},
            )
        return library

    def require_page_settings_store() -> PageSettingsStore:
        """页面设置必须跟随当前资料库，未打开资料库时不能退回全局路径。"""

        if page_settings_store is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": "library_not_open", "message": "尚未打开资料库"},
            )
        return page_settings_store

    def save_current_path(path: str | None) -> None:
        if os.getenv("OPENVIDEO_LIBRARY_PATH") is None:
            preference_store.save(preferences_from_settings(resolved_settings, path))

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if library is None and resolved_settings.library_path:
            try:
                if (resolved_settings.library_path / "library.json").is_file():
                    await install_library(MediaLibrary.open(resolved_settings.library_path))
                elif settings is not None and not any(resolved_settings.library_path.iterdir()):
                    await install_library(MediaLibrary.initialize_directory(resolved_settings.library_path))
            except (LibraryError, OSError):
                pass
        try:
            yield
        finally:
            if library:
                library.close()

    app = FastAPI(title="OpenVideo API", version="0.1.0", lifespan=lifespan)
    app.state.library = library
    app.state.download_manager = manager
    app.state.analysis_manager = analysis_manager
    app.state.page_settings_store = page_settings_store
    app.state.settings = resolved_settings
    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved_settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
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
            job = analysis_manager.create_analysis(
                asset_id,
                request.mode,
                request.marker_ids,
                request.ai_model_id,
                request.force,
            )
        except AnalysisPrerequisiteError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except AnalysisError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        if job.stage.value != "complete":
            analysis_manager.start(job.job_id)
        return job

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, error: HTTPException):
        if isinstance(error.detail, dict) and "code" in error.detail:
            return JSONResponse(status_code=error.status_code, content=error.detail)
        return JSONResponse(status_code=error.status_code, content={"detail": error.detail})

    @app.middleware("http")
    async def require_open_library(request: Request, call_next):
        managed_prefixes = (
            "/api/media",
            "/api/downloads",
            "/api/analysis",
            "/api/page-settings",
        )
        if request.url.path.startswith(managed_prefixes) and library is None:
            return JSONResponse(
                status_code=status.HTTP_409_CONFLICT,
                content={"code": "library_not_open", "message": "尚未打开资料库"},
            )
        return await call_next(request)

    @app.get("/api/library", response_model=LibraryDescription | None)
    def get_library() -> LibraryDescription | None:
        return library.description if library else None

    @app.post("/api/directories/select", response_model=DirectorySelectionResponse)
    async def choose_directory() -> DirectorySelectionResponse:
        if directory_picker_lock.locked():
            _library_error(409, "directory_picker_busy", "文件夹选择器已打开")
        try:
            async with directory_picker_lock:
                selected_path = await asyncio.to_thread(pick_directory)
        except DirectoryPickerError as error:
            _library_error(503, "directory_picker_unavailable", str(error))
        return DirectorySelectionResponse(path=selected_path)

    @app.post("/api/library/create", response_model=LibraryDescription, status_code=201)
    async def create_library(request: LibraryCreateRequest) -> LibraryDescription:
        if os.getenv("OPENVIDEO_LIBRARY_PATH"):
            _library_error(409, "library_managed_by_environment", "资料库由环境变量固定，无法切换")
        _ensure_switch_allowed(manager, analysis_manager)
        requested_path = _absolute_library_path(request.path)
        try:
            opened = MediaLibrary.initialize_directory(requested_path)
        except (LibraryError, OSError) as error:
            error_code = error.code if isinstance(error, LibraryError) else "library_create_failed"
            _library_error(422, error_code, str(error))
        if library:
            library.close()
        await install_library(opened)
        save_current_path(str(opened.library_path))
        return opened.description

    @app.post("/api/library/open", response_model=LibraryDescription)
    async def open_library(request: LibraryOpenRequest) -> LibraryDescription:
        if os.getenv("OPENVIDEO_LIBRARY_PATH"):
            _library_error(409, "library_managed_by_environment", "资料库由环境变量固定，无法切换")
        target = _absolute_library_path(request.path)
        if library and target == library.library_path:
            return library.description
        _ensure_switch_allowed(manager, analysis_manager)
        try:
            opened = MediaLibrary.open(target)
        except (LibraryError, OSError) as error:
            error_code = error.code if isinstance(error, LibraryError) else "library_open_failed"
            _library_error(422, error_code, str(error))
        if library:
            library.close()
        await install_library(opened)
        save_current_path(str(opened.library_path))
        return opened.description

    @app.delete("/api/library", status_code=204)
    def close_library() -> Response:
        nonlocal library, manager, analysis_manager, page_settings_store
        if os.getenv("OPENVIDEO_LIBRARY_PATH"):
            _library_error(409, "library_managed_by_environment", "资料库由环境变量固定，无法关闭")
        _ensure_switch_allowed(manager, analysis_manager)
        if library:
            library.close()
        library = None
        manager = None
        analysis_manager = None
        page_settings_store = None
        app.state.library = None
        app.state.page_settings_store = None
        save_current_path(None)
        return Response(status_code=204)

    @app.get("/api/preferences", response_model=PreferencesResponse)
    def get_preferences() -> PreferencesResponse:
        return _preferences_response(resolved_settings)

    @app.patch("/api/preferences", response_model=PreferencesResponse)
    def update_preferences(request: PreferencesPatch) -> PreferencesResponse:
        for field, value in request.model_dump(exclude_unset=True).items():
            if field not in resolved_settings.managed_fields:
                setattr(resolved_settings, field, value)
        save_current_path(str(library.library_path) if library else None)
        return _preferences_response(resolved_settings)

    @app.get("/api/ai/models", response_model=list[AiModelSummary])
    def list_ai_models() -> list[AiModelSummary]:
        return [
            AiModelSummary(
                model_id=model.model_id,
                name=model.name,
                litellm_model=model.litellm_model,
                supports_vision=model.supports_vision,
            )
            for model in resolved_settings.ai_models
        ]

    @app.get(
        "/api/page-settings/analysis",
        response_model=AnalysisPageSettings,
    )
    def get_analysis_page_settings() -> AnalysisPageSettings:
        return require_page_settings_store().load_analysis()

    @app.put(
        "/api/page-settings/analysis",
        response_model=AnalysisPageSettings,
    )
    def update_analysis_page_settings(
        request: AnalysisPageSettings,
    ) -> AnalysisPageSettings:
        return require_page_settings_store().save_analysis(request)

    @app.post(
        "/api/media/assets/{asset_id}/transcribe",
        response_model=AnalysisJob,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def transcribe_asset(
        asset_id: str,
        request: TranscriptionCreateRequest = TranscriptionCreateRequest(),
    ) -> AnalysisJob:
        try:
            job = analysis_manager.create_transcription(
                asset_id,
                TranscriptionOptions(
                    model=request.model,
                    language=request.language,
                    compute_type=request.compute_type,
                ),
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

    @app.patch(
        "/api/media/assets/{asset_id}/transcript/segments/{segment_index}",
        response_model=Transcript,
    )
    def update_transcript_segment(
        asset_id: str,
        segment_index: int,
        request: TranscriptSegmentUpdateRequest,
    ) -> Transcript:
        _ready_asset(library, asset_id)
        normalized_text = request.text.strip()
        if not normalized_text:
            raise HTTPException(status_code=422, detail="转写文字不能为空")
        try:
            return analysis_manager.update_transcript_segment(
                asset_id,
                segment_index,
                normalized_text,
            )
        except AnalysisError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.post(
        "/api/media/assets/{asset_id}/transcript/correct",
        response_model=Transcript,
    )
    def correct_transcript(
        asset_id: str,
        request: TranscriptCorrectionRequest,
    ) -> Transcript:
        _ready_asset(library, asset_id)
        try:
            return analysis_manager.correct_transcript(
                asset_id,
                request.segment_indices,
                request.ai_model_id,
            )
        except AnalysisPrerequisiteError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except AnalysisError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

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


def _library_error(status_code: int, code: str, message: str):
    raise HTTPException(status_code=status_code, detail={"code": code, "message": message})


def _absolute_library_path(raw_path: str) -> Path:
    path = Path(raw_path)
    if not path.is_absolute():
        _library_error(422, "library_path_not_absolute", "资料库路径必须是绝对路径")
    resolved_path = path.resolve()
    if resolved_path.is_relative_to(PROJECT_ROOT):
        _library_error(
            422,
            "library_path_inside_application",
            "资料库不能放在 OpenVideo 项目目录内部",
        )
    return resolved_path


def _ensure_switch_allowed(
    manager: DownloadManager | None,
    analysis_manager: AnalysisManager | None,
) -> None:
    if (manager and manager.has_active_jobs()) or (
        analysis_manager and analysis_manager.has_active_jobs()
    ):
        _library_error(409, "library_has_active_tasks", "存在运行中的任务，暂时无法切换资料库")


def _preferences_response(settings: Settings) -> PreferencesResponse:
    values = settings.model_dump(exclude={"library_path", "cors_origins", "managed_fields"})
    return PreferencesResponse(
        **values,
        managed_fields=sorted(settings.managed_fields),
        library_path_managed=os.getenv("OPENVIDEO_LIBRARY_PATH") is not None,
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
