from collections.abc import Callable
from contextlib import asynccontextmanager
from enum import StrEnum
from pathlib import Path
from threading import Event
from uuid import UUID
import asyncio
import os
import re

from fastapi import FastAPI, HTTPException, Query, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import (
    BaseModel,
    Field,
    SecretStr,
    field_validator,
)

from openvideo.agent_service import (
    AgentService,
)
from openvideo.analysis_manager import AnalysisManager
from openvideo.download_manager import DownloadManager
from openvideo.summary_manager import SummaryManager
from openvideo.core.ai_models import (
    AiModelCollection,
)
from openvideo.core.transcription_models import (
    TranscriptionEngine,
    TranscriptionModelDownloadJob,
    TranscriptionModelState,
    TranscriptionOptions,
)
from openvideo.core.download_models import (
    DownloadQuality,
    DownloadStage,
    DownloadTask,
)
from openvideo.core.library import (
    FolderNotFoundError,
    LibraryDescription,
    LibraryError,
    MediaLibrary,
)
from openvideo.core.identifiers import uuid7
from openvideo.core.media_models import SourcePlatform
from openvideo.core.page_settings import (
    LEGACY_PAGE_SETTINGS_FILE_NAME,
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
from openvideo.download_accounts import (
    DownloadAccount,
    DownloadAccountError,
    DownloadAccountExpired,
    DownloadAccountLoginCancelled,
    DownloadAccountStore,
    DownloadCookieBrowser,
    capture_cookie_from_dedicated_browser,
    import_cookie_from_browser,
)
from openvideo.tools.downloader import (
    DownloadFailure,
    PlaylistProbe,
    is_authentication_failure,
    probe_source,
    read_download_metadata,
)
from openvideo.llm.capability_resolver import CapabilityResolver
from openvideo.tools.sources import UnsupportedSourceError, resolve_source
from openvideo.transcription_model_manager import (
    TranscriptionModelDownloadError,
    TranscriptionModelManager,
)
from openvideo.ui.directory_picker import DirectoryPickerError, select_directory
from openvideo.ui.media_routes import register_media_routes
from openvideo.ui.page_settings_routes import register_page_settings_routes
from openvideo.ui.analysis_routes import register_analysis_routes
from openvideo.ui.agent_routes import register_agent_routes
from openvideo.ui.ai_routes import register_ai_routes
from openvideo.ui.library_routes import register_library_routes
from openvideo.ui.health_routes import register_health_routes
from openvideo.ui.summary_routes import register_summary_routes


MAX_BATCH_DOWNLOADS = 100
DEFAULT_DOWNLOAD_HISTORY_LIMIT = 50
MAX_DOWNLOAD_HISTORY_LIMIT = 100
DOWNLOAD_ACCOUNT_TEST_URLS = {
    SourcePlatform.BILIBILI: "https://www.bilibili.com/video/BV1xx411c7mD",
    SourcePlatform.DOUYIN: "https://www.douyin.com/video/6961737553342991651",
    SourcePlatform.YOUTUBE: "https://www.youtube.com/watch?v=BaW_jenozKc",
}
DOWNLOAD_ACCOUNT_LOGIN_ID_PATTERN = re.compile(r"^login-[0-9a-f]{32}$")


class ProbeRequest(BaseModel):
    source_url: str


class DownloadAccountConnectRequest(BaseModel):
    cookie: SecretStr = Field(min_length=1, max_length=16_000)


class DownloadAccountTestRequest(BaseModel):
    source_url: str | None = None


class DownloadAccountBrowserImportRequest(BaseModel):
    browser: DownloadCookieBrowser
    source_url: str | None = None


class DownloadAccountLoginStage(StrEnum):
    WAITING = "waiting"
    COMPLETE = "complete"
    FAILED = "failed"
    CANCELLED = "cancelled"


class DownloadAccountLoginSession(BaseModel):
    login_id: str
    platform: SourcePlatform
    stage: DownloadAccountLoginStage = DownloadAccountLoginStage.WAITING
    message: str = "请在专用浏览器窗口完成登录"
    account: DownloadAccount | None = None

    @field_validator("login_id")
    @classmethod
    def validate_login_id(cls, login_id: str) -> str:
        if not DOWNLOAD_ACCOUNT_LOGIN_ID_PATTERN.fullmatch(login_id):
            raise ValueError("账号登录会话 ID 格式无效")
        login_uuid = UUID(hex=login_id.removeprefix("login-"))
        if login_uuid.version != 7:
            raise ValueError("账号登录会话 ID 必须使用 UUIDv7")
        return login_id


def _download_account_test_url(
    platform: SourcePlatform,
    source_url: str | None,
) -> str:
    """账号测试必须使用同平台链接，避免误把另一平台的公开访问判为登录成功。"""
    if not source_url:
        return DOWNLOAD_ACCOUNT_TEST_URLS[platform]
    try:
        match = resolve_source(source_url)
    except UnsupportedSourceError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    if match.platform != platform:
        raise HTTPException(status_code=422, detail="请使用当前平台的视频地址测试账号")
    return match.normalized_url


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
    video_quality: DownloadQuality = DownloadQuality.BEST
    folder_id: str | None = None
    automatic_folder_name: str | None = None
    assign_folder: bool = False


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




def create_app(
    settings: Settings | None = None,
    preference_store: PreferenceStore | None = None,
    directory_picker: Callable[[], str | None] | None = None,
    download_account_store: DownloadAccountStore | None = None,
    download_account_login_capture: Callable[[SourcePlatform, Event], str]
    | None = None,
    capability_resolver: CapabilityResolver | None = None,
) -> FastAPI:
    preference_store = preference_store or PreferenceStore()
    resolved_settings = settings or load_settings(preference_store)
    library: MediaLibrary | None = None
    manager: DownloadManager | None = None
    analysis_manager: AnalysisManager | None = None
    agent_service: AgentService | None = None
    summary_manager: SummaryManager | None = None
    resolved_capability_resolver = capability_resolver or CapabilityResolver()
    transcription_model_manager = TranscriptionModelManager(resolved_settings)
    page_settings_store: PageSettingsStore | None = None
    pick_directory = directory_picker or select_directory
    directory_picker_lock = asyncio.Lock()
    account_store = download_account_store or DownloadAccountStore()
    capture_account_login = (
        download_account_login_capture or capture_cookie_from_dedicated_browser
    )
    account_login_sessions: dict[str, DownloadAccountLoginSession] = {}
    account_login_cancellations: dict[str, Event] = {}
    account_login_tasks: dict[str, asyncio.Task[None]] = {}

    async def run_download_account_login(
        login_id: str,
        platform: SourcePlatform,
        cancel_event: Event,
    ) -> None:
        try:
            cookie_header = await asyncio.to_thread(
                capture_account_login,
                platform,
                cancel_event,
            )
            if cancel_event.is_set():
                raise DownloadAccountLoginCancelled("账号登录已取消")
            account_store.save(platform, cookie_header)
            with account_store.cookie_file(platform) as cookie_source:
                assert cookie_source is not None
                await asyncio.to_thread(
                    read_download_metadata,
                    DOWNLOAD_ACCOUNT_TEST_URLS[platform],
                    platform,
                    cookie_source,
                )
            account = account_store.mark_available(platform)
            assert account is not None
            account_login_sessions[login_id] = DownloadAccountLoginSession(
                login_id=login_id,
                platform=platform,
                stage=DownloadAccountLoginStage.COMPLETE,
                message="登录成功",
                account=account,
            )
        except DownloadAccountLoginCancelled as error:
            account_login_sessions[login_id] = DownloadAccountLoginSession(
                login_id=login_id,
                platform=platform,
                stage=DownloadAccountLoginStage.CANCELLED,
                message=str(error),
            )
        except DownloadFailure as error:
            if is_authentication_failure(error):
                account_store.mark_expired(platform)
            account_login_sessions[login_id] = DownloadAccountLoginSession(
                login_id=login_id,
                platform=platform,
                stage=DownloadAccountLoginStage.FAILED,
                message=str(error) or "无法验证账号登录状态",
            )
        except DownloadAccountError as error:
            account_login_sessions[login_id] = DownloadAccountLoginSession(
                login_id=login_id,
                platform=platform,
                stage=DownloadAccountLoginStage.FAILED,
                message=str(error),
            )

    async def install_library(opened_library: MediaLibrary) -> None:
        nonlocal \
            library, \
            manager, \
            analysis_manager, \
            agent_service, \
            summary_manager, \
            page_settings_store
        library = opened_library
        manager = DownloadManager(opened_library, resolved_settings, account_store)
        analysis_manager = AnalysisManager(opened_library, resolved_settings)
        summary_manager = SummaryManager(opened_library, resolved_settings)
        agent_service = AgentService(
            opened_library,
            resolved_settings,
            summary_manager,
            resolved_capability_resolver,
        )
        page_settings_store = PageSettingsStore(
            preference_store.path.parent,
            opened_library.manifest.library_id,
            opened_library.library_path / LEGACY_PAGE_SETTINGS_FILE_NAME,
        )
        analysis_manager.restore()
        app.state.library = opened_library
        app.state.download_manager = manager
        app.state.analysis_manager = analysis_manager
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
            for cancel_event in account_login_cancellations.values():
                cancel_event.set()
            if account_login_tasks:
                await asyncio.gather(
                    *account_login_tasks.values(),
                    return_exceptions=True,
                )
            if agent_service:
                await agent_service.close()
            if library:
                library.close()

    app = FastAPI(title="OpenVideo API", version="0.1.0", lifespan=lifespan)
    app.state.library = library
    app.state.download_manager = manager
    app.state.analysis_manager = analysis_manager
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

    @app.post("/api/downloads/probe", response_model=ProbeResponse)
    async def probe_download(request: ProbeRequest) -> ProbeResponse:
        try:
            match = resolve_source(request.source_url)
        except UnsupportedSourceError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        probe_target = match.playlist_url or match.normalized_url
        try:
            with account_store.cookie_file(match.platform) as cookie_source:
                probe = await asyncio.to_thread(
                    probe_source,
                    probe_target,
                    match.platform,
                    match.source_video_id,
                    cookie_source,
                )
                if cookie_source is not None:
                    account_store.mark_available(match.platform)
        except DownloadAccountExpired as error:
            raise HTTPException(status_code=401, detail=str(error)) from error
        except DownloadAccountError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except DownloadFailure as error:
            if is_authentication_failure(error):
                account_store.mark_expired(match.platform)
            raise HTTPException(
                status_code=502, detail=str(error) or "无法读取视频信息"
            ) from error
        return _probe_response(match.platform, probe)

    @app.get(
        "/api/download-accounts",
        response_model=list[DownloadAccount],
    )
    def list_download_accounts() -> list[DownloadAccount]:
        try:
            return account_store.list_accounts()
        except DownloadAccountError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @app.post(
        "/api/download-accounts/{platform}/login-sessions",
        response_model=DownloadAccountLoginSession,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def create_download_account_login_session(
        platform: SourcePlatform,
    ) -> DownloadAccountLoginSession:
        stale_login_ids = [
            login_id
            for login_id, session in account_login_sessions.items()
            if session.platform == platform
            and session.stage != DownloadAccountLoginStage.WAITING
        ]
        for stale_login_id in stale_login_ids:
            account_login_sessions.pop(stale_login_id, None)
            account_login_cancellations.pop(stale_login_id, None)
            account_login_tasks.pop(stale_login_id, None)
        active_session = next(
            (
                session
                for session in account_login_sessions.values()
                if session.platform == platform
                and session.stage == DownloadAccountLoginStage.WAITING
            ),
            None,
        )
        if active_session is not None:
            return active_session.model_copy(deep=True)
        login_id = f"login-{uuid7().hex}"
        session = DownloadAccountLoginSession(login_id=login_id, platform=platform)
        cancel_event = Event()
        account_login_sessions[login_id] = session
        account_login_cancellations[login_id] = cancel_event
        account_login_tasks[login_id] = asyncio.create_task(
            run_download_account_login(login_id, platform, cancel_event)
        )
        return session.model_copy(deep=True)

    @app.get(
        "/api/download-account-login-sessions/{login_id}",
        response_model=DownloadAccountLoginSession,
    )
    async def get_download_account_login_session(
        login_id: str,
    ) -> DownloadAccountLoginSession:
        session = account_login_sessions.get(login_id)
        if session is None:
            raise HTTPException(status_code=404, detail="账号登录会话不存在")
        return session.model_copy(deep=True)

    @app.delete(
        "/api/download-account-login-sessions/{login_id}",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    async def delete_download_account_login_session(login_id: str) -> Response:
        session = account_login_sessions.get(login_id)
        if session is None:
            raise HTTPException(status_code=404, detail="账号登录会话不存在")
        cancel_event = account_login_cancellations[login_id]
        cancel_event.set()
        await account_login_tasks[login_id]
        account_login_sessions.pop(login_id, None)
        account_login_cancellations.pop(login_id, None)
        account_login_tasks.pop(login_id, None)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @app.get(
        "/api/download-accounts/{platform}",
        response_model=DownloadAccount | None,
    )
    def get_download_account(platform: SourcePlatform) -> DownloadAccount | None:
        try:
            return account_store.get(platform)
        except DownloadAccountError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @app.put(
        "/api/download-accounts/{platform}",
        response_model=DownloadAccount,
    )
    def save_download_account(
        platform: SourcePlatform,
        request: DownloadAccountConnectRequest,
    ) -> DownloadAccount:
        try:
            return account_store.save(platform, request.cookie.get_secret_value())
        except DownloadAccountError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post(
        "/api/download-accounts/{platform}/import-browser",
        response_model=DownloadAccount,
    )
    async def import_download_account_from_browser(
        platform: SourcePlatform,
        request: DownloadAccountBrowserImportRequest,
    ) -> DownloadAccount:
        test_url = _download_account_test_url(platform, request.source_url)
        try:
            cookie_header = await asyncio.to_thread(
                import_cookie_from_browser,
                platform,
                request.browser,
                test_url,
            )
            account_store.save(platform, cookie_header)
            imported_account = account_store.mark_available(platform)
            assert imported_account is not None
            return imported_account
        except DownloadAccountError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post(
        "/api/download-accounts/{platform}/test",
        response_model=DownloadAccount,
    )
    async def test_download_account(
        platform: SourcePlatform,
        request: DownloadAccountTestRequest,
    ) -> DownloadAccount:
        account = account_store.get(platform)
        if account is None:
            raise HTTPException(status_code=404, detail="尚未连接该平台账号")
        test_url = _download_account_test_url(platform, request.source_url)
        try:
            with account_store.cookie_file(platform) as cookie_source:
                assert cookie_source is not None
                await asyncio.to_thread(
                    read_download_metadata,
                    test_url,
                    platform,
                    cookie_source,
                )
            tested_account = account_store.mark_available(platform)
            assert tested_account is not None
            return tested_account
        except DownloadAccountExpired as error:
            raise HTTPException(status_code=401, detail=str(error)) from error
        except DownloadAccountError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except DownloadFailure as error:
            if is_authentication_failure(error):
                account_store.mark_expired(platform)
                raise HTTPException(status_code=401, detail=str(error)) from error
            raise HTTPException(status_code=502, detail=str(error)) from error

    @app.delete(
        "/api/download-accounts/{platform}",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    def delete_download_account(platform: SourcePlatform) -> Response:
        try:
            account_store.delete(platform)
        except DownloadAccountError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @app.post(
        "/api/downloads",
        response_model=list[DownloadTask],
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def create_downloads(request: BatchDownloadRequest) -> list[DownloadTask]:
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
        try:
            folder_id = request.folder_id
            if folder_id is None and request.automatic_folder_name:
                folder_id = library.create_or_get_root_folder(
                    request.automatic_folder_name
                ).folder_id
            assign_ready_folder = request.assign_folder or bool(
                request.automatic_folder_name
            )
            jobs = manager.create_batch(
                matches,
                folder_id,
                assign_ready_folder,
                request.video_quality,
            )
        except (FolderNotFoundError, ValueError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        for job in jobs:
            if job.stage.value != "complete":
                manager.start(job.job_id)
        return [
            task for job in jobs if (task := manager.get_task(job.job_id)) is not None
        ]

    @app.get("/api/downloads", response_model=list[DownloadTask])
    def list_downloads(
        limit: int = Query(
            default=DEFAULT_DOWNLOAD_HISTORY_LIMIT,
            ge=1,
            le=MAX_DOWNLOAD_HISTORY_LIMIT,
        ),
    ) -> list[DownloadTask]:
        return manager.list_tasks(limit) if manager else []

    @app.get("/api/downloads/{job_id}", response_model=DownloadTask)
    def get_download(job_id: str) -> DownloadTask:
        task = manager.get_task(job_id)
        if not task:
            raise HTTPException(status_code=404, detail="下载任务不存在")
        return task

    @app.post(
        "/api/downloads/{job_id}/retry",
        response_model=DownloadTask,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def retry_download(job_id: str) -> DownloadTask:
        try:
            job = manager.retry(job_id)
        except LookupError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        if job.stage != DownloadStage.COMPLETE:
            manager.start(job.job_id)
        task = manager.get_task(job.job_id)
        if task is None:
            raise HTTPException(status_code=404, detail="重新下载任务不存在")
        return task



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
            "/api/agent-",
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
            manager,
            analysis_manager,
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
        if agent_service:
            await agent_service.close()
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
            agent_service,
        )
        try:
            opened = MediaLibrary.open(target)
        except (LibraryError, OSError) as error:
            error_code = (
                error.code if isinstance(error, LibraryError) else "library_open_failed"
            )
            _library_error(422, error_code, str(error))
        if agent_service:
            await agent_service.close()
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
            agent_service,
        )
        if agent_service:
            await agent_service.close()
        if library:
            library.close()
        library = None
        manager = None
        analysis_manager = None
        agent_service = None
        summary_manager = None
        page_settings_store = None
        app.state.library = None
        app.state.download_manager = None
        app.state.analysis_manager = None
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


    register_page_settings_routes(app, require_page_settings_store)

    register_health_routes(app, resolved_settings)
    register_analysis_routes(
        app,
        lambda: library,
        lambda: analysis_manager,
        resolved_settings,
    )

    register_ai_routes(app, resolved_settings, resolved_capability_resolver)
    register_summary_routes(app, lambda: summary_manager)
    register_agent_routes(app, lambda: agent_service)
    register_library_routes(
        app,
        lambda: library,
        lambda: manager,
        lambda: analysis_manager,
        lambda: agent_service,
    )

    register_media_routes(app, lambda: library, resolved_settings)

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
    agent_service: AgentService | None,
) -> None:
    if (
        (manager and manager.has_active_jobs())
        or (analysis_manager and analysis_manager.has_active_jobs())
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


def _entry_download_url(platform: SourcePlatform, video_id: str, raw_url: str) -> str:
    """把浅层条目补全成 resolve_source 能识别的规范单视频地址。

    yt-dlp 的 --flat-playlist 对不同平台返回完整 URL 或裸 ID，统一按平台重建，
    确保批量下载端点里的每个地址都能通过来源校验。
    """
    if platform == SourcePlatform.BILIBILI:
        return raw_url or f"https://www.bilibili.com/video/{video_id}"
    if platform == SourcePlatform.DOUYIN:
        return f"https://www.douyin.com/video/{video_id}"
    if platform == SourcePlatform.YOUTUBE:
        return f"https://www.youtube.com/watch?v={video_id}"
    return raw_url


app = create_app()
