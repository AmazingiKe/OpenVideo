from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Event
import asyncio
import os

from fastapi import FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from openvideo.core.agent_governance_models import AgentPreferences
from openvideo.agent_service import (
    AgentService,
)
from openvideo.analysis_manager import AnalysisManager
from openvideo.download_manager import DownloadManager
from openvideo.event_analysis_manager import EventAnalysisManager
from openvideo.summary_manager import SummaryManager
from openvideo.core.ai_models import (
    AiModelCollection,
    AiModelConfiguration,
)
from openvideo.core.transcription_models import (
    TranscriptionEngine,
    TranscriptionModelDownloadJob,
    TranscriptionModelState,
    TranscriptionOptions,
)
from openvideo.core.library import (
    LibraryDescription,
    LibraryError,
    MediaLibrary,
)
from openvideo.core.media_models import SourcePlatform
from openvideo.core.page_settings import (
    LEGACY_PAGE_SETTINGS_FILE_NAME,
    PageSettingsStore,
)
from openvideo.preferences import PreferenceStore
from openvideo.settings import (
    AGENT_PREFERENCES_FIELD,
    AI_MODELS_FIELD,
    DEFAULT_TRANSCRIPTION_FIELD,
    MODELS_DIRECTORY_FIELD,
    PROJECT_ROOT,
    TOOLS_DIRECTORY_FIELD,
    Settings,
    load_settings,
    preferences_from_settings,
)
from openvideo.download_accounts import (
    DownloadAccountStore,
    capture_cookie_from_dedicated_browser,
)
from openvideo.llm.capability_resolver import CapabilityResolver
from openvideo.transcription_model_manager import (
    TranscriptionModelDownloadError,
    TranscriptionModelManager,
)
from openvideo.agent_retrieval_models import NeuralRetrievalModels
from openvideo.ui.directory_picker import DirectoryPickerError, select_directory
from openvideo.ui.media_routes import register_media_routes
from openvideo.ui.page_settings_routes import register_page_settings_routes
from openvideo.ui.analysis_routes import register_analysis_routes
from openvideo.ui.agent_routes import register_agent_routes
from openvideo.ui.ai_routes import register_ai_routes
from openvideo.ui.library_routes import register_library_routes
from openvideo.ui.health_routes import register_health_routes
from openvideo.ui.summary_routes import register_summary_routes
from openvideo.ui.download_account_routes import (
    DownloadAccountLoginManager,
    register_download_account_routes,
)
from openvideo.ui.download_routes import register_download_routes
from openvideo.ui.event_analysis_routes import register_event_analysis_routes


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
    agent: AgentPreferences | None = None


class PreferencesResponse(AiModelCollection):
    tools_directory: str | None
    models_directory: str | None
    default_transcription: TranscriptionOptions
    agent: AgentPreferences
    managed_fields: list[str]
    library_path_managed: bool




def create_app(
    settings: Settings | None = None,
    preference_store: PreferenceStore | None = None,
    directory_picker: Callable[[], str | None] | None = None,
    download_account_store: DownloadAccountStore | None = None,
    download_account_login_capture: Callable[[SourcePlatform, Event], str]
    | None = None,
    capability_resolver: CapabilityResolver | None = None,
    retrieval_models: NeuralRetrievalModels | None = None,
    automatic_initialization: bool = False,
) -> FastAPI:
    preference_store = preference_store or PreferenceStore()
    resolved_settings = settings or load_settings(preference_store)
    library: MediaLibrary | None = None
    manager: DownloadManager | None = None
    analysis_manager: AnalysisManager | None = None
    event_analysis_manager: EventAnalysisManager | None = None
    agent_service: AgentService | None = None
    summary_manager: SummaryManager | None = None
    resolved_capability_resolver = capability_resolver or CapabilityResolver()
    transcription_model_manager = TranscriptionModelManager(resolved_settings)
    page_settings_store: PageSettingsStore | None = None
    pick_directory = directory_picker or select_directory
    directory_picker_lock = asyncio.Lock()
    account_store = download_account_store or DownloadAccountStore()
    account_login_manager = DownloadAccountLoginManager(
        account_store,
        download_account_login_capture or capture_cookie_from_dedicated_browser,
    )

    async def install_library(opened_library: MediaLibrary) -> None:
        nonlocal \
            library, \
            manager, \
            analysis_manager, \
            event_analysis_manager, \
            agent_service, \
            summary_manager, \
            page_settings_store
        library = opened_library
        analysis_manager = AnalysisManager(
            opened_library,
            resolved_settings,
            on_evidence_ready=lambda: (
                agent_service.refresh_index() if agent_service is not None else None
            ),
        )
        manager = DownloadManager(
            opened_library,
            resolved_settings,
            account_store,
            analysis_manager.initialize_asset if automatic_initialization else None,
        )
        event_analysis_manager = EventAnalysisManager(opened_library, resolved_settings)
        summary_manager = SummaryManager(opened_library, resolved_settings)
        agent_service = AgentService(
            opened_library,
            resolved_settings,
            summary_manager,
            resolved_capability_resolver,
            retrieval_models,
        )
        page_settings_store = PageSettingsStore(
            preference_store.path.parent,
            opened_library.manifest.library_id,
            opened_library.library_path / LEGACY_PAGE_SETTINGS_FILE_NAME,
        )
        analysis_manager.restore()
        if automatic_initialization:
            analysis_manager.initialize_ready_assets()
        event_analysis_manager.restore()
        app.state.library = opened_library
        app.state.download_manager = manager
        app.state.analysis_manager = analysis_manager
        app.state.event_analysis_manager = event_analysis_manager
        app.state.agent_service = agent_service
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
            await account_login_manager.close()
            if analysis_manager:
                await analysis_manager.close()
            if agent_service:
                await agent_service.close()
            if event_analysis_manager:
                await event_analysis_manager.close()
            if library:
                library.close()

    app = FastAPI(title="OpenVideo API", version="0.1.0", lifespan=lifespan)
    app.state.library = library
    app.state.download_manager = manager
    app.state.analysis_manager = analysis_manager
    app.state.event_analysis_manager = event_analysis_manager
    app.state.agent_service = agent_service
    app.state.summary_manager = summary_manager
    app.state.transcription_model_manager = transcription_model_manager
    app.state.page_settings_store = page_settings_store
    app.state.settings = resolved_settings
    app.state.download_account_store = account_store
    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved_settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
        allow_headers=["Content-Type", "Range"],
    )

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
            "/api/library/folders",
            "/api/analysis",
            "/api/event-analysis",
            "/api/agent-",
            "/api/summary",
            "/api/page-settings",
            "/assets/media-",
        )
        global_resource_paths = {"/api/summary-presets"}
        if (
            request.url.path not in global_resource_paths
            and request.url.path.startswith(managed_prefixes)
            and library is None
        ):
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
            manager,
            analysis_manager,
            event_analysis_manager,
            agent_service,
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
        if analysis_manager:
            await analysis_manager.close()
        if agent_service:
            await agent_service.close()
        if event_analysis_manager:
            await event_analysis_manager.close()
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
            manager,
            analysis_manager,
            event_analysis_manager,
            agent_service,
        )
        try:
            opened = MediaLibrary.open(target)
        except (LibraryError, OSError) as error:
            error_code = (
                error.code if isinstance(error, LibraryError) else "library_open_failed"
            )
            _library_error(422, error_code, str(error))
        if analysis_manager:
            await analysis_manager.close()
        if agent_service:
            await agent_service.close()
        if event_analysis_manager:
            await event_analysis_manager.close()
        if library:
            library.close()
        await install_library(opened)
        save_current_path(str(opened.library_path))
        return opened.description

    @app.delete("/api/library", status_code=204)
    async def close_library() -> Response:
        nonlocal \
            library, \
            manager, \
            analysis_manager, \
            event_analysis_manager, \
            agent_service, \
            summary_manager, \
            page_settings_store
        if os.getenv("OPENVIDEO_LIBRARY_PATH"):
            _library_error(
                409, "library_managed_by_environment", "资料库由环境变量固定，无法关闭"
            )
        _ensure_switch_allowed(
            manager,
            analysis_manager,
            event_analysis_manager,
            agent_service,
        )
        if analysis_manager:
            await analysis_manager.close()
        if agent_service:
            await agent_service.close()
        if event_analysis_manager:
            await event_analysis_manager.close()
        if library:
            library.close()
        library = None
        manager = None
        analysis_manager = None
        event_analysis_manager = None
        agent_service = None
        summary_manager = None
        page_settings_store = None
        app.state.library = None
        app.state.download_manager = None
        app.state.analysis_manager = None
        app.state.event_analysis_manager = None
        app.state.agent_service = None
        app.state.summary_manager = None
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
        candidate_models = (
            request.ai_models
            if AI_MODELS_FIELD in provided_fields
            and AI_MODELS_FIELD not in managed_fields
            else resolved_settings.ai_models
        )
        candidate_agent = (
            request.agent
            if AGENT_PREFERENCES_FIELD in provided_fields
            and request.agent is not None
            else resolved_settings.agent
        )
        _validate_agent_model_roles(candidate_agent, candidate_models)
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
        if AGENT_PREFERENCES_FIELD in provided_fields and request.agent is not None:
            resolved_settings.agent = request.agent
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


    register_page_settings_routes(app, require_page_settings_store)
    register_download_account_routes(app, account_store, account_login_manager)
    register_download_routes(app, lambda: library, lambda: manager, account_store)

    register_health_routes(app, resolved_settings)
    register_analysis_routes(
        app,
        lambda: library,
        lambda: analysis_manager,
        resolved_settings,
    )
    register_event_analysis_routes(
        app,
        lambda: library,
        lambda: event_analysis_manager,
    )

    register_ai_routes(app, resolved_settings, resolved_capability_resolver)
    register_summary_routes(app, lambda: summary_manager)
    register_agent_routes(
        app,
        lambda: agent_service,
        lambda: save_current_path(
            str(library.library_path) if library is not None else None
        ),
    )
    register_library_routes(
        app,
        lambda: library,
        lambda: manager,
        lambda: analysis_manager,
        lambda: agent_service,
    )

    register_media_routes(app, lambda: library, resolved_settings)

    return app


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
    event_analysis_manager: EventAnalysisManager | None,
    agent_service: AgentService | None,
) -> None:
    if (
        (manager and manager.has_active_jobs())
        or (analysis_manager and analysis_manager.has_active_jobs())
        or (event_analysis_manager and event_analysis_manager.has_active_jobs())
        or (agent_service and agent_service.has_active_jobs())
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


def _validate_agent_model_roles(
    agent: AgentPreferences,
    models: list[AiModelConfiguration],
) -> None:
    """模型角色必须引用同一份用户模型注册表，避免运行时才发现悬空配置。"""

    registered_model_ids = {model.model_id for model in models}
    role_model_ids = {
        model_id
        for model_id in (
            agent.fast_model_id,
            agent.complex_model_id,
            agent.vision_model_id,
        )
        if model_id is not None
    }
    if role_model_ids - registered_model_ids:
        raise HTTPException(
            status_code=422,
            detail="Agent 模型角色必须从已注册模型中选择",
        )


app = create_app(
    retrieval_models=NeuralRetrievalModels(),
    automatic_initialization=True,
)
