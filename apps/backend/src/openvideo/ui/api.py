from collections.abc import Callable, Iterator
from contextlib import asynccontextmanager
from pathlib import Path
from time import perf_counter
import asyncio
import json
import os

from fastapi import FastAPI, Header, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, ValidationError

from openvideo.agent_manager import AgentError, AgentManager
from openvideo.application import (
    AnalysisError,
    AnalysisManager,
    AnalysisPrerequisiteError,
    DownloadManager,
)
from openvideo.summary_manager import (
    SummaryError,
    SummaryManager,
    SummaryNotFoundError,
    SummaryRevisionConflictError,
)
from openvideo.core.agent_models import AgentJob, AgentResponse
from openvideo.core.ai_models import (
    AiModelCollection,
    AiModelConfiguration,
    InputModality,
)
from openvideo.core.analysis_models import (
    ANALYSIS_STRATEGY_PRESETS,
    AnalysisJob,
    AnalysisMode,
    AnalysisStrategy,
    AnalysisStrategyPresetDescriptor,
    Transcript,
    TranscriptionComputeType,
    TranscriptionDevice,
    TranscriptionEngine,
    TranscriptionModelDownloadJob,
    TranscriptionModelState,
    TranscriptionOptions,
)
from openvideo.core.byte_range import InvalidByteRange, parse_byte_range
from openvideo.core.library import (
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
from openvideo.settings import (
    AI_MODELS_FIELD,
    DEFAULT_TRANSCRIPTION_FIELD,
    MODELS_DIRECTORY_FIELD,
    PROJECT_ROOT,
    TOOLS_DIRECTORY_FIELD,
    Settings,
    load_settings,
    preferences_from_settings,
)
from openvideo.core.summary_models import (
    SummaryAgentMessageRequest,
    SummaryAgentRun,
    SummaryConversationState,
    SummaryDocument,
    SummaryDocumentCreate,
    SummaryDocumentReorder,
    SummaryDocumentUpdate,
    SummaryEditProposal,
    SummaryExportResult,
    SummaryGenerationRequest,
    SummaryMediaArtifact,
    SummaryMediaCreate,
)
from openvideo.tools.downloader import (
    DownloadFailure,
    PlaylistProbe,
    probe_source,
    yt_dlp_available,
)
from openvideo.tools.media import media_tool_status
from openvideo.tools.llm import LlmCompletionError, complete_text
from openvideo.tools.sources import UnsupportedSourceError, resolve_source
from openvideo.transcription_model_manager import (
    TranscriptionModelDownloadError,
    TranscriptionModelManager,
)
from openvideo.ui.directory_picker import DirectoryPickerError, select_directory


STREAM_CHUNK_SIZE = 1024 * 1024
VIDEO_MEDIA_TYPE = "video/mp4"
MAX_BATCH_DOWNLOADS = 100
MILLISECONDS_PER_SECOND = 1_000
MODEL_TEST_MAX_TOKENS = 8
MODEL_TEST_PROMPT = "Reply only with OK."
MODEL_TEST_REDACTED_SECRET = "[已隐藏]"
MODEL_TEST_SUCCESS_MESSAGE = "模型响应正常"
MODEL_TEST_TIMEOUT_SECONDS = 30
SUMMARY_DOCUMENT_EVENT_POLL_SECONDS = 0.5
SUMMARY_DOCUMENT_EVENT_KEEPALIVE_SECONDS = 15


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
    strategy: AnalysisStrategy = Field(default_factory=AnalysisStrategy)


class TranscriptionCreateRequest(BaseModel):
    force: bool = False
    engine: TranscriptionEngine | None = None
    model: str | None = None
    language: str | None = None
    device: TranscriptionDevice | None = None
    compute_type: TranscriptionComputeType | None = None


class LibraryCreateRequest(BaseModel):
    path: str


class LibraryOpenRequest(BaseModel):
    path: str


class DirectorySelectionResponse(BaseModel):
    path: str | None


class PreferencesPatch(AiModelCollection):
    tools_directory: str | None = None
    models_directory: str | None = None
    default_transcription: TranscriptionOptions | None = None


class PreferencesResponse(AiModelCollection):
    tools_directory: str | None
    models_directory: str | None
    default_transcription: TranscriptionOptions
    managed_fields: list[str]
    library_path_managed: bool


class AiModelSummary(BaseModel):
    model_id: str
    name: str
    litellm_model: str
    input_modalities: list[InputModality]


class AiModelTestResponse(BaseModel):
    available: bool
    latency_ms: int
    message: str


class SummaryMediaCreateResponse(BaseModel):
    artifact: SummaryMediaArtifact
    document: SummaryDocument


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
    agent_manager: AgentManager | None = None
    summary_manager: SummaryManager | None = None
    transcription_model_manager = TranscriptionModelManager(resolved_settings)
    page_settings_store: PageSettingsStore | None = None
    pick_directory = directory_picker or select_directory
    directory_picker_lock = asyncio.Lock()

    async def install_library(opened_library: MediaLibrary) -> None:
        nonlocal \
            library, \
            manager, \
            analysis_manager, \
            agent_manager, \
            summary_manager, \
            page_settings_store
        library = opened_library
        manager = DownloadManager(opened_library, resolved_settings)
        analysis_manager = AnalysisManager(opened_library, resolved_settings)
        agent_manager = AgentManager(opened_library, resolved_settings)
        summary_manager = SummaryManager(opened_library, resolved_settings)
        page_settings_store = PageSettingsStore(
            preference_store.path.parent,
            opened_library.manifest.library_id,
            opened_library.library_path / LEGACY_PAGE_SETTINGS_FILE_NAME,
        )
        analysis_manager.restore()
        agent_manager.restore()
        app.state.library = opened_library
        app.state.download_manager = manager
        app.state.analysis_manager = analysis_manager
        app.state.agent_manager = agent_manager
        app.state.summary_manager = summary_manager
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
                    await install_library(
                        MediaLibrary.open(resolved_settings.library_path)
                    )
                elif settings is not None and not any(
                    resolved_settings.library_path.iterdir()
                ):
                    await install_library(
                        MediaLibrary.initialize_directory(
                            resolved_settings.library_path
                        )
                    )
            except (LibraryError, OSError):
                pass
        try:
            yield
        finally:
            if agent_manager:
                await agent_manager.close()
            if summary_manager:
                await summary_manager.close()
            if library:
                library.close()

    app = FastAPI(title="OpenVideo API", version="0.1.0", lifespan=lifespan)
    app.state.library = library
    app.state.download_manager = manager
    app.state.analysis_manager = analysis_manager
    app.state.agent_manager = agent_manager
    app.state.summary_manager = summary_manager
    app.state.transcription_model_manager = transcription_model_manager
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
        service_status = (
            "ready" if dependencies.yt_dlp and dependencies.ffmpeg else "degraded"
        )
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
            raise HTTPException(
                status_code=502, detail=str(error) or "无法读取视频信息"
            ) from error
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
                request.strategy,
                request.force,
            )
        except AnalysisPrerequisiteError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except AnalysisError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        if job.stage.value != "complete":
            analysis_manager.start(job.job_id)
        return job

    @app.get(
        "/api/analysis-strategies",
        response_model=list[AnalysisStrategyPresetDescriptor],
    )
    def list_analysis_strategies() -> list[AnalysisStrategyPresetDescriptor]:
        return [preset.model_copy(deep=True) for preset in ANALYSIS_STRATEGY_PRESETS]

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, error: HTTPException):
        if isinstance(error.detail, dict) and "code" in error.detail:
            return JSONResponse(status_code=error.status_code, content=error.detail)
        return JSONResponse(
            status_code=error.status_code, content={"detail": error.detail}
        )

    @app.middleware("http")
    async def require_open_library(request: Request, call_next):
        managed_prefixes = (
            "/api/media",
            "/api/downloads",
            "/api/analysis",
            "/api/agent-jobs",
            "/api/summary",
            "/api/page-settings",
            "/assets/media-",
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
            _library_error(
                409, "library_managed_by_environment", "资料库由环境变量固定，无法切换"
            )
        _ensure_switch_allowed(
            manager, analysis_manager, agent_manager, summary_manager
        )
        requested_path = _absolute_library_path(request.path)
        try:
            opened = MediaLibrary.initialize_directory(requested_path)
        except (LibraryError, OSError) as error:
            error_code = (
                error.code
                if isinstance(error, LibraryError)
                else "library_create_failed"
            )
            _library_error(422, error_code, str(error))
        if agent_manager:
            await agent_manager.close()
        if library:
            library.close()
        await install_library(opened)
        save_current_path(str(opened.library_path))
        return opened.description

    @app.post("/api/library/open", response_model=LibraryDescription)
    async def open_library(request: LibraryOpenRequest) -> LibraryDescription:
        if os.getenv("OPENVIDEO_LIBRARY_PATH"):
            _library_error(
                409, "library_managed_by_environment", "资料库由环境变量固定，无法切换"
            )
        target = _absolute_library_path(request.path)
        if library and target == library.library_path:
            return library.description
        _ensure_switch_allowed(
            manager, analysis_manager, agent_manager, summary_manager
        )
        try:
            opened = MediaLibrary.open(target)
        except (LibraryError, OSError) as error:
            error_code = (
                error.code if isinstance(error, LibraryError) else "library_open_failed"
            )
            _library_error(422, error_code, str(error))
        if agent_manager:
            await agent_manager.close()
        if library:
            library.close()
        await install_library(opened)
        save_current_path(str(opened.library_path))
        return opened.description

    @app.delete("/api/library", status_code=204)
    async def close_library() -> Response:
        nonlocal library, manager, analysis_manager, agent_manager, page_settings_store
        if os.getenv("OPENVIDEO_LIBRARY_PATH"):
            _library_error(
                409, "library_managed_by_environment", "资料库由环境变量固定，无法关闭"
            )
        _ensure_switch_allowed(
            manager, analysis_manager, agent_manager, summary_manager
        )
        if agent_manager:
            await agent_manager.close()
        if library:
            library.close()
        library = None
        manager = None
        analysis_manager = None
        agent_manager = None
        page_settings_store = None
        app.state.library = None
        app.state.download_manager = None
        app.state.analysis_manager = None
        app.state.agent_manager = None
        app.state.page_settings_store = None
        save_current_path(None)
        return Response(status_code=204)

    @app.get("/api/preferences", response_model=PreferencesResponse)
    def get_preferences() -> PreferencesResponse:
        return _preferences_response(resolved_settings)

    @app.patch("/api/preferences", response_model=PreferencesResponse)
    def update_preferences(request: PreferencesPatch) -> PreferencesResponse:
        provided_fields = request.model_fields_set
        managed_fields = resolved_settings.managed_fields
        if (
            TOOLS_DIRECTORY_FIELD in provided_fields
            and TOOLS_DIRECTORY_FIELD not in managed_fields
        ):
            resolved_settings.tools_directory = request.tools_directory
        if (
            MODELS_DIRECTORY_FIELD in provided_fields
            and MODELS_DIRECTORY_FIELD not in managed_fields
        ):
            resolved_settings.models_directory = request.models_directory
        if AI_MODELS_FIELD in provided_fields and AI_MODELS_FIELD not in managed_fields:
            resolved_settings.ai_models = request.ai_models
        if (
            DEFAULT_TRANSCRIPTION_FIELD in provided_fields
            and request.default_transcription is not None
        ):
            resolved_settings.default_transcription = request.default_transcription
        save_current_path(str(library.library_path) if library else None)
        return _preferences_response(resolved_settings)

    @app.get(
        "/api/transcription/models",
        response_model=list[TranscriptionModelState],
    )
    def list_transcription_models() -> list[TranscriptionModelState]:
        return transcription_model_manager.list_models()

    @app.post(
        "/api/transcription/models/{engine}/{model}/downloads",
        response_model=TranscriptionModelDownloadJob,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def download_transcription_model(
        engine: TranscriptionEngine,
        model: str,
    ) -> TranscriptionModelDownloadJob:
        try:
            job = transcription_model_manager.create_download(engine, model)
        except TranscriptionModelDownloadError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        transcription_model_manager.start(job.job_id)
        return job

    @app.get(
        "/api/transcription/model-downloads/{job_id}",
        response_model=TranscriptionModelDownloadJob,
    )
    def get_transcription_model_download(
        job_id: str,
    ) -> TranscriptionModelDownloadJob:
        job = transcription_model_manager.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="模型下载任务不存在")
        return job

    @app.get("/api/ai/models", response_model=list[AiModelSummary])
    def list_ai_models() -> list[AiModelSummary]:
        return [
            AiModelSummary(
                model_id=model.model_id,
                name=model.name,
                litellm_model=model.litellm_model,
                input_modalities=model.input_modalities,
            )
            for model in resolved_settings.ai_models
        ]

    @app.post("/api/ai/models/test", response_model=AiModelTestResponse)
    def test_ai_model(request: AiModelConfiguration) -> AiModelTestResponse:
        started_at = perf_counter()
        try:
            complete_text(
                request,
                [{"role": "user", "content": MODEL_TEST_PROMPT}],
                timeout_seconds=MODEL_TEST_TIMEOUT_SECONDS,
                max_tokens=MODEL_TEST_MAX_TOKENS,
                disable_thinking=True,
            )
        except LlmCompletionError as error:
            error_message = str(error)
            if request.api_key:
                error_message = error_message.replace(
                    request.api_key,
                    MODEL_TEST_REDACTED_SECRET,
                )
            return AiModelTestResponse(
                available=False,
                latency_ms=round(
                    (perf_counter() - started_at) * MILLISECONDS_PER_SECOND
                ),
                message=error_message,
            )
        return AiModelTestResponse(
            available=True,
            latency_ms=round((perf_counter() - started_at) * MILLISECONDS_PER_SECOND),
            message=MODEL_TEST_SUCCESS_MESSAGE,
        )

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
            option_values = request.model_dump(
                exclude={"force"},
                exclude_unset=True,
            )
            option_values = {
                field: value
                for field, value in option_values.items()
                if value is not None or field == "language"
            }
            default_values = resolved_settings.default_transcription.model_dump()
            options = TranscriptionOptions.model_validate(
                {**default_values, **option_values}
            )
            job = analysis_manager.create_transcription(
                asset_id,
                options,
                request.force,
            )
        except ValidationError as error:
            message = (
                error.errors()[0]
                .get("ctx", {})
                .get(
                    "error",
                    error.errors()[0]["msg"],
                )
            )
            raise HTTPException(status_code=422, detail=str(message)) from error
        except AnalysisPrerequisiteError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
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
        "/api/media/assets/{asset_id}/transcript/corrections",
        response_model=AgentJob,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def create_transcript_correction(
        asset_id: str,
        request: TranscriptCorrectionRequest,
    ) -> AgentJob:
        _ready_asset(library, asset_id)
        try:
            job = agent_manager.create_transcript_correction(
                asset_id,
                request.segment_indices,
                request.ai_model_id,
            )
        except AgentError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        if job.stage.value == "pending":
            agent_manager.start(job.job_id)
        return job

    @app.get("/api/agent-jobs/{job_id}", response_model=AgentJob)
    def get_agent_job(job_id: str) -> AgentJob:
        job = agent_manager.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Agent 任务不存在")
        return job

    @app.post(
        "/api/agent-jobs/{job_id}/responses",
        response_model=AgentJob,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def respond_to_agent_job(
        job_id: str,
        request: AgentResponse,
    ) -> AgentJob:
        try:
            return agent_manager.respond(job_id, request)
        except AgentError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.get(
        "/api/media/assets/{asset_id}/agent-jobs",
        response_model=list[AgentJob],
    )
    def list_asset_agent_jobs(
        asset_id: str,
        active: bool = False,
    ) -> list[AgentJob]:
        _ready_asset(library, asset_id)
        return agent_manager.list_jobs(asset_id, active)

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

    @app.get(
        "/api/media/assets/{asset_id}/summary-documents",
        response_model=list[SummaryDocument],
    )
    def list_summary_documents(asset_id: str) -> list[SummaryDocument]:
        try:
            return summary_manager.documents(asset_id)
        except SummaryError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.get("/api/media/assets/{asset_id}/summary-documents/events")
    async def summary_document_events(
        asset_id: str,
        request: Request,
    ) -> StreamingResponse:
        try:
            initial_documents = summary_manager.documents(asset_id)
        except SummaryError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

        async def stream_events():
            documents = initial_documents
            previous_signature: tuple[tuple[str, int], ...] | None = None
            idle_seconds = 0.0
            while not await request.is_disconnected():
                signature = tuple(
                    (document.document_id, document.revision)
                    for document in documents
                )
                if signature != previous_signature:
                    payload = [
                        document.model_dump(mode="json") for document in documents
                    ]
                    yield _sse_event("documents", payload)
                    previous_signature = signature
                    idle_seconds = 0.0
                elif idle_seconds >= SUMMARY_DOCUMENT_EVENT_KEEPALIVE_SECONDS:
                    yield ": keep-alive\n\n"
                    idle_seconds = 0.0
                await asyncio.sleep(SUMMARY_DOCUMENT_EVENT_POLL_SECONDS)
                idle_seconds += SUMMARY_DOCUMENT_EVENT_POLL_SECONDS
                documents = summary_manager.documents(asset_id)

        return StreamingResponse(
            stream_events(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    @app.post(
        "/api/media/assets/{asset_id}/summary-documents/generate",
        response_model=list[SummaryDocument],
        status_code=status.HTTP_201_CREATED,
    )
    def generate_summary_documents(
        asset_id: str,
        request: SummaryGenerationRequest,
    ) -> list[SummaryDocument]:
        try:
            return summary_manager.generate(asset_id, request)
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except SummaryError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.post(
        "/api/summary-documents/{root_document_id}/children",
        response_model=SummaryDocument,
        status_code=status.HTTP_201_CREATED,
    )
    def create_summary_child(
        root_document_id: str,
        request: SummaryDocumentCreate,
    ) -> SummaryDocument:
        try:
            return summary_manager.create_child(root_document_id, request)
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except (SummaryError, ValueError) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.patch(
        "/api/summary-documents/{document_id}",
        response_model=SummaryDocument,
    )
    def update_summary_document(
        document_id: str,
        request: SummaryDocumentUpdate,
    ) -> SummaryDocument:
        try:
            return summary_manager.update_document(document_id, request)
        except SummaryRevisionConflictError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.put(
        "/api/summary-documents/{root_document_id}/children/order",
        response_model=list[SummaryDocument],
    )
    def reorder_summary_children(
        root_document_id: str,
        request: SummaryDocumentReorder,
    ) -> list[SummaryDocument]:
        try:
            return summary_manager.reorder_children(
                root_document_id, request.document_ids
            )
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.delete(
        "/api/summary-documents/{document_id}",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    def delete_summary_document(document_id: str) -> Response:
        try:
            summary_manager.delete_child(document_id)
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @app.get(
        "/api/media/assets/{asset_id}/summary-conversation",
        response_model=SummaryConversationState,
    )
    def get_summary_conversation(asset_id: str) -> SummaryConversationState:
        try:
            return summary_manager.conversation_state(asset_id)
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.post(
        "/api/summary-conversations/{conversation_id}/messages",
        response_model=SummaryAgentRun,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def create_summary_agent_run(
        conversation_id: str,
        request: SummaryAgentMessageRequest,
    ) -> SummaryAgentRun:
        try:
            return summary_manager.create_agent_run(conversation_id, request)
        except SummaryRevisionConflictError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except SummaryError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.get("/api/summary-agent-runs/{run_id}/events")
    async def summary_agent_events(run_id: str) -> StreamingResponse:
        try:
            summary_manager.agent_run(run_id)
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

        async def stream_events():
            previous_stage = None
            while True:
                run = summary_manager.agent_run(run_id)
                if run.stage != previous_stage:
                    yield _sse_event("status", {"stage": run.stage.value})
                    previous_stage = run.stage
                if run.stage.value == "complete":
                    if run.assistant_message_id:
                        messages = library.load_summary_messages(run.conversation_id)
                        message = next(
                            (
                                item
                                for item in messages
                                if item.message_id == run.assistant_message_id
                            ),
                            None,
                        )
                        if message:
                            yield _sse_event("reply", message.model_dump(mode="json"))
                    if run.proposal_id:
                        proposal = library.load_summary_proposal(run.proposal_id)
                        if proposal:
                            yield _sse_event(
                                "proposal", proposal.model_dump(mode="json")
                            )
                    yield _sse_event("complete", {"run_id": run.run_id})
                    break
                if run.stage.value == "failed":
                    yield _sse_event(
                        "error",
                        {"run_id": run.run_id, "message": run.error_message},
                    )
                    break
                await asyncio.sleep(0.1)

        return StreamingResponse(stream_events(), media_type="text/event-stream")

    @app.post(
        "/api/summary-edit-proposals/{proposal_id}/accept",
        response_model=SummaryEditProposal,
    )
    def accept_summary_proposal(proposal_id: str) -> SummaryEditProposal:
        try:
            return summary_manager.accept_proposal(proposal_id)
        except SummaryRevisionConflictError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.post(
        "/api/summary-edit-proposals/{proposal_id}/reject",
        response_model=SummaryEditProposal,
    )
    def reject_summary_proposal(proposal_id: str) -> SummaryEditProposal:
        try:
            return summary_manager.reject_proposal(proposal_id)
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.post(
        "/api/summary-media",
        response_model=SummaryMediaCreateResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_summary_media(
        request: SummaryMediaCreate,
    ) -> SummaryMediaCreateResponse:
        try:
            artifact, document = await summary_manager.create_media(request)
            return SummaryMediaCreateResponse(artifact=artifact, document=document)
        except SummaryRevisionConflictError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except SummaryError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.get("/api/summary-media/{media_id}")
    def get_summary_media(media_id: str) -> FileResponse:
        try:
            return FileResponse(summary_manager.media_path(media_id))
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.get("/assets/{media_file}")
    def get_relative_summary_media(media_file: str) -> FileResponse:
        file_name = Path(media_file)
        if file_name.name != media_file or file_name.suffix not in {".jpg", ".gif"}:
            raise HTTPException(status_code=404, detail="总结媒体不存在")
        try:
            media_path = summary_manager.media_path(file_name.stem)
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        if media_path.suffix != file_name.suffix:
            raise HTTPException(status_code=404, detail="总结媒体不存在")
        return FileResponse(media_path)

    @app.post(
        "/api/media/assets/{asset_id}/summary-exports",
        response_model=SummaryExportResult,
        status_code=status.HTTP_201_CREATED,
    )
    def export_summary(asset_id: str) -> SummaryExportResult:
        try:
            return summary_manager.export(asset_id)
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except SummaryError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

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
                    status_code=206, media_type=VIDEO_MEDIA_TYPE, headers=headers
                )
            return StreamingResponse(
                _read_file_range(media_file, byte_range.start, byte_range.length),
                status_code=206,
                media_type=VIDEO_MEDIA_TYPE,
                headers=headers,
            )
        headers = {**common_headers, "Content-Length": str(total_size)}
        if request.method == "HEAD":
            return Response(
                status_code=200, media_type=VIDEO_MEDIA_TYPE, headers=headers
            )
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
    raise HTTPException(
        status_code=status_code, detail={"code": code, "message": message}
    )


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
    agent_manager: AgentManager | None,
    summary_manager: SummaryManager | None,
) -> None:
    if (
        (manager and manager.has_active_jobs())
        or (analysis_manager and analysis_manager.has_active_jobs())
        or (agent_manager and agent_manager.has_active_jobs())
        or (summary_manager and summary_manager.has_active_jobs())
    ):
        _library_error(
            409, "library_has_active_tasks", "存在运行中的任务，暂时无法切换资料库"
        )


def _preferences_response(settings: Settings) -> PreferencesResponse:
    values = settings.model_dump(
        exclude={"library_path", "cors_origins", "managed_fields"}
    )
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


def _sse_event(event: str, payload: object) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


app = create_app()
