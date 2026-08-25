from collections.abc import Callable, Iterator
from contextlib import asynccontextmanager
from enum import StrEnum
from pathlib import Path
from threading import Event
from time import perf_counter
from uuid import UUID
import asyncio
import json
import os
import re

from fastapi import FastAPI, Header, HTTPException, Query, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, SecretStr, ValidationError, field_validator

from openvideo.agent_manager import AgentError, AgentManager
from openvideo.marker_agent_manager import (
    MarkerAgentError,
    MarkerAgentManager,
    MarkerAgentNotFoundError,
    MarkerProposalConflictError,
)
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
from openvideo.core.agent_runtime_models import AgentEventType, AgentRun, AgentRunStage
from openvideo.core.ai_models import (
    AiModelCollection,
    AiModelConfiguration,
    InputModality,
    ToolCallingMode,
)
from openvideo.core.analysis_models import (
    ANALYSIS_STRATEGY_PRESETS,
    AnalysisJob,
    AnalysisMode,
    AnalysisStrategy,
    AnalysisStrategyPresetDescriptor,
)
from openvideo.core.transcription_models import (
    Transcript,
    TranscriptionComputeType,
    TranscriptionDevice,
    TranscriptionEngine,
    TranscriptionModelDownloadJob,
    TranscriptionModelState,
    TranscriptionOptions,
)
from openvideo.core.byte_range import InvalidByteRange, parse_byte_range
from openvideo.core.download_models import DownloadTask
from openvideo.core.library import (
    FolderConflictError,
    FolderNotFoundError,
    LibraryDescription,
    LibraryError,
    MediaLibrary,
)
from openvideo.core.folder_models import FolderResponse
from openvideo.core.identifiers import uuid7
from openvideo.core.media_models import (
    MARKER_RANGE_MAX_SECONDS,
    MARKER_RANGE_MIN_SECONDS,
    MARKER_RANGE_STEP_SECONDS,
    MediaAssetResponse,
    MediaAssetStatus,
    MediaMarker,
    MediaSegment,
    SourcePlatform,
)
from openvideo.core.page_settings import (
    LEGACY_PAGE_SETTINGS_FILE_NAME,
    MarkersPageSettings,
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
    SummaryAgentSession,
    SummaryAgentSessionState,
    SummaryAgentSessionCreate,
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
from openvideo.core.marker_agent_models import (
    MarkerAgentMessageRequest,
    MarkerAgentSession,
    MarkerAgentSessionState,
    MarkerProposal,
)
from openvideo.tools.downloader import (
    DownloadFailure,
    PlaylistProbe,
    is_authentication_failure,
    probe_source,
    read_download_metadata,
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
DEFAULT_DOWNLOAD_HISTORY_LIMIT = 50
MAX_DOWNLOAD_HISTORY_LIMIT = 100
MILLISECONDS_PER_SECOND = 1_000
MODEL_TEST_MAX_TOKENS = 8
MODEL_TEST_PROMPT = "Reply only with OK."
MODEL_TEST_REDACTED_SECRET = "[已隐藏]"
MODEL_TEST_SUCCESS_MESSAGE = "模型响应正常"
MODEL_TEST_TIMEOUT_SECONDS = 30
SUMMARY_DOCUMENT_EVENT_POLL_SECONDS = 0.5
SUMMARY_DOCUMENT_EVENT_KEEPALIVE_SECONDS = 15
DOWNLOAD_ACCOUNT_TEST_URLS = {
    SourcePlatform.BILIBILI: "https://www.bilibili.com/video/BV1xx411c7mD",
    SourcePlatform.DOUYIN: "https://www.douyin.com/video/6961737553342991651",
    SourcePlatform.YOUTUBE: "https://www.youtube.com/watch?v=BaW_jenozKc",
}
DOWNLOAD_ACCOUNT_LOGIN_ID_PATTERN = re.compile(r"^login-[0-9a-f]{32}$")


class DependencyStatus(BaseModel):
    yt_dlp: bool
    ffmpeg: bool
    ffprobe: bool


class HealthResponse(BaseModel):
    status: str
    dependencies: DependencyStatus


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
    folder_id: str | None = None


class FolderCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    parent_id: str | None = None


class FolderRenameRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class FolderMoveRequest(BaseModel):
    parent_id: str | None = None


class FolderDeleteRequest(BaseModel):
    confirmation_name: str | None = None


class AssetMoveRequest(BaseModel):
    asset_ids: list[str] = Field(min_length=1, max_length=100)
    folder_id: str | None = None


class MarkerCreateRequest(BaseModel):
    start_seconds: float = Field(ge=0)
    end_seconds: float | None = Field(default=None, ge=0)
    title: str = Field(default="", max_length=200)
    tags: list[str] = Field(default_factory=list)
    marker_range_before_seconds: int | None = Field(
        default=None,
        ge=MARKER_RANGE_MIN_SECONDS,
        le=MARKER_RANGE_MAX_SECONDS,
        multiple_of=MARKER_RANGE_STEP_SECONDS,
    )
    marker_range_after_seconds: int | None = Field(
        default=None,
        ge=MARKER_RANGE_MIN_SECONDS,
        le=MARKER_RANGE_MAX_SECONDS,
        multiple_of=MARKER_RANGE_STEP_SECONDS,
    )


class MarkerUpdateRequest(BaseModel):
    start_seconds: float = Field(ge=0)
    end_seconds: float | None = Field(default=None, ge=0)
    title: str = Field(default="", max_length=200)
    tags: list[str] = Field(default_factory=list)
    marker_range_before_seconds: int | None = Field(
        ge=MARKER_RANGE_MIN_SECONDS,
        le=MARKER_RANGE_MAX_SECONDS,
        multiple_of=MARKER_RANGE_STEP_SECONDS,
    )
    marker_range_after_seconds: int | None = Field(
        ge=MARKER_RANGE_MIN_SECONDS,
        le=MARKER_RANGE_MAX_SECONDS,
        multiple_of=MARKER_RANGE_STEP_SECONDS,
    )


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
    tool_calling_mode: ToolCallingMode


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
    download_account_store: DownloadAccountStore | None = None,
    download_account_login_capture: Callable[[SourcePlatform, Event], str]
    | None = None,
) -> FastAPI:
    preference_store = preference_store or PreferenceStore()
    resolved_settings = settings or load_settings(preference_store)
    library: MediaLibrary | None = None
    manager: DownloadManager | None = None
    analysis_manager: AnalysisManager | None = None
    agent_manager: AgentManager | None = None
    summary_manager: SummaryManager | None = None
    marker_agent_manager: MarkerAgentManager | None = None
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
            agent_manager, \
            summary_manager, \
            marker_agent_manager, \
            page_settings_store
        library = opened_library
        manager = DownloadManager(opened_library, resolved_settings, account_store)
        analysis_manager = AnalysisManager(opened_library, resolved_settings)
        agent_manager = AgentManager(opened_library, resolved_settings)
        summary_manager = SummaryManager(opened_library, resolved_settings)
        marker_agent_manager = MarkerAgentManager(opened_library, resolved_settings)
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
        app.state.marker_agent_manager = marker_agent_manager
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
            if agent_manager:
                await agent_manager.close()
            if summary_manager:
                await summary_manager.close()
            if marker_agent_manager:
                await marker_agent_manager.close()
            if library:
                library.close()

    app = FastAPI(title="OpenVideo API", version="0.1.0", lifespan=lifespan)
    app.state.library = library
    app.state.download_manager = manager
    app.state.analysis_manager = analysis_manager
    app.state.agent_manager = agent_manager
    app.state.summary_manager = summary_manager
    app.state.marker_agent_manager = marker_agent_manager
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
            jobs = manager.create_batch(matches, request.folder_id)
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

    @app.get("/api/library/folders", response_model=list[FolderResponse])
    def list_folders() -> list[FolderResponse]:
        return library.list_folders()

    @app.post(
        "/api/library/folders",
        response_model=FolderResponse,
        status_code=status.HTTP_201_CREATED,
    )
    def create_folder(request: FolderCreateRequest) -> FolderResponse:
        try:
            return library.create_folder(request.name, request.parent_id)
        except FolderNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except FolderConflictError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.patch("/api/library/folders/{folder_id}", response_model=FolderResponse)
    def rename_folder(folder_id: str, request: FolderRenameRequest) -> FolderResponse:
        try:
            return library.rename_folder(folder_id, request.name)
        except FolderNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except FolderConflictError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.put("/api/library/folders/{folder_id}/parent", response_model=FolderResponse)
    def move_folder(folder_id: str, request: FolderMoveRequest) -> FolderResponse:
        try:
            return library.move_folder(folder_id, request.parent_id)
        except FolderNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except FolderConflictError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post("/api/media/assets/move", response_model=list[MediaAssetResponse])
    def move_assets(request: AssetMoveRequest) -> list[MediaAssetResponse]:
        try:
            assets = library.move_assets(request.asset_ids, request.folder_id)
        except FolderNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return [library.response_for(asset) for asset in assets]

    @app.delete("/api/media/assets/{asset_id}", status_code=204)
    async def delete_asset(asset_id: str) -> Response:
        try:
            asset = library.get(asset_id)
        except ValueError as error:
            raise HTTPException(status_code=404, detail="媒体资源不存在") from error
        if asset is None:
            raise HTTPException(status_code=404, detail="媒体资源不存在")
        await _stop_asset_tasks(
            {asset_id},
            manager,
            analysis_manager,
            agent_manager,
            summary_manager,
            marker_agent_manager,
        )
        try:
            library.delete_asset(asset_id)
        except (OSError, ValueError) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @app.delete("/api/library/folders/{folder_id}", status_code=204)
    async def delete_folder(
        folder_id: str,
        request: FolderDeleteRequest | None = None,
    ) -> Response:
        try:
            folder = library.get_folder(folder_id)
            asset_ids = library.folder_asset_ids(folder_id)
            has_descendants = any(
                candidate.folder_id != folder_id
                and candidate.materialized_path.startswith(folder.materialized_path)
                for candidate in library.list_folders()
            )
        except FolderNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        if (asset_ids or has_descendants) and (
            request is None or request.confirmation_name != folder.name
        ):
            raise HTTPException(
                status_code=409,
                detail="非空文件夹必须输入完整名称确认永久删除",
            )
        await _stop_asset_tasks(
            set(asset_ids),
            manager,
            analysis_manager,
            agent_manager,
            summary_manager,
            marker_agent_manager,
        )
        try:
            for asset_id in asset_ids:
                library.delete_asset(asset_id)
            library.delete_folder(folder_id)
        except (FolderConflictError, OSError, ValueError) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @app.get("/api/media/assets", response_model=list[MediaAssetResponse])
    def list_assets(
        folder_id: str | None = None,
        uncategorized: bool = False,
        search: str | None = Query(default=None, max_length=200),
        sort_by: str = "created_at",
        sort_order: str = "desc",
    ) -> list[MediaAssetResponse]:
        try:
            assets = library.list(
                folder_id=folder_id,
                uncategorized=uncategorized,
                search=search,
                sort_by=sort_by,
                sort_order=sort_order,
            )
        except FolderNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return [library.response_for(asset) for asset in assets]

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
            "/api/library/folders",
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
            manager,
            analysis_manager,
            agent_manager,
            summary_manager,
            marker_agent_manager,
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
        if summary_manager:
            await summary_manager.close()
        if marker_agent_manager:
            await marker_agent_manager.close()
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
            agent_manager,
            summary_manager,
            marker_agent_manager,
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
        if summary_manager:
            await summary_manager.close()
        if marker_agent_manager:
            await marker_agent_manager.close()
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
            agent_manager, \
            summary_manager, \
            marker_agent_manager, \
            page_settings_store
        if os.getenv("OPENVIDEO_LIBRARY_PATH"):
            _library_error(
                409, "library_managed_by_environment", "资料库由环境变量固定，无法关闭"
            )
        _ensure_switch_allowed(
            manager,
            analysis_manager,
            agent_manager,
            summary_manager,
            marker_agent_manager,
        )
        if agent_manager:
            await agent_manager.close()
        if summary_manager:
            await summary_manager.close()
        if marker_agent_manager:
            await marker_agent_manager.close()
        if library:
            library.close()
        library = None
        manager = None
        analysis_manager = None
        agent_manager = None
        summary_manager = None
        marker_agent_manager = None
        page_settings_store = None
        app.state.library = None
        app.state.download_manager = None
        app.state.analysis_manager = None
        app.state.agent_manager = None
        app.state.summary_manager = None
        app.state.marker_agent_manager = None
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
                tool_calling_mode=model.tool_calling_mode,
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
        "/api/page-settings/markers",
        response_model=MarkersPageSettings,
    )
    def get_markers_page_settings() -> MarkersPageSettings:
        return require_page_settings_store().load_markers()

    @app.put(
        "/api/page-settings/markers",
        response_model=MarkersPageSettings,
    )
    def update_markers_page_settings(
        request: MarkersPageSettings,
    ) -> MarkersPageSettings:
        return require_page_settings_store().save_markers(request)

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
        asset = _ready_asset(library, asset_id)
        _validate_marker_bounds(
            request.start_seconds, request.end_seconds, asset.duration_seconds
        )
        marker = MediaMarker(
            marker_id=f"marker-{uuid7().hex}",
            asset_id=asset_id,
            start_seconds=request.start_seconds,
            end_seconds=request.end_seconds,
            title=request.title,
            tags=request.tags,
            marker_range_before_seconds=request.marker_range_before_seconds,
            marker_range_after_seconds=request.marker_range_after_seconds,
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
        asset = _ready_asset(library, asset_id)
        _validate_marker_bounds(
            request.start_seconds, request.end_seconds, asset.duration_seconds
        )
        try:
            marker = library.update_marker(
                asset_id,
                marker_id,
                start_seconds=request.start_seconds,
                end_seconds=request.end_seconds,
                title=request.title,
                tags=request.tags,
                marker_range_before_seconds=request.marker_range_before_seconds,
                marker_range_after_seconds=request.marker_range_after_seconds,
            )
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
                    (document.document_id, document.revision) for document in documents
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
        "/api/media/assets/{asset_id}/summary-agent-sessions",
        response_model=list[SummaryAgentSession],
    )
    def list_summary_agent_sessions(asset_id: str) -> list[SummaryAgentSession]:
        try:
            return summary_manager.agent_sessions(asset_id)
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.post(
        "/api/media/assets/{asset_id}/summary-agent-sessions",
        response_model=SummaryAgentSessionState,
        status_code=status.HTTP_201_CREATED,
    )
    def create_summary_agent_session(
        asset_id: str, request: SummaryAgentSessionCreate
    ) -> SummaryAgentSessionState:
        try:
            return summary_manager.create_agent_session(asset_id, request)
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.get(
        "/api/summary-agent-sessions/{session_id}",
        response_model=SummaryAgentSessionState,
    )
    def get_summary_agent_session(session_id: str) -> SummaryAgentSessionState:
        try:
            return summary_manager.agent_session_state(session_id)
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.delete(
        "/api/summary-agent-sessions/{session_id}",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    def delete_summary_agent_session(session_id: str) -> Response:
        try:
            summary_manager.delete_agent_session(session_id)
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except SummaryError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @app.get(
        "/api/media/assets/{asset_id}/marker-agent-sessions",
        response_model=list[MarkerAgentSession],
    )
    def list_marker_agent_sessions(asset_id: str) -> list[MarkerAgentSession]:
        try:
            return marker_agent_manager.sessions(asset_id)
        except MarkerAgentNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.post(
        "/api/media/assets/{asset_id}/marker-agent-sessions",
        response_model=MarkerAgentSessionState,
        status_code=status.HTTP_201_CREATED,
    )
    def create_marker_agent_session(asset_id: str) -> MarkerAgentSessionState:
        try:
            return marker_agent_manager.create_session(asset_id)
        except MarkerAgentNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.get(
        "/api/marker-agent-sessions/{session_id}",
        response_model=MarkerAgentSessionState,
    )
    def get_marker_agent_session(session_id: str) -> MarkerAgentSessionState:
        try:
            return marker_agent_manager.session_state(session_id)
        except MarkerAgentNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.delete(
        "/api/marker-agent-sessions/{session_id}",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    def delete_marker_agent_session(session_id: str) -> Response:
        try:
            marker_agent_manager.delete_session(session_id)
        except MarkerAgentNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except MarkerAgentError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @app.post(
        "/api/marker-agent-sessions/{session_id}/messages",
        response_model=AgentRun,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def create_marker_agent_message(
        session_id: str, request: MarkerAgentMessageRequest
    ) -> AgentRun:
        try:
            return marker_agent_manager.create_message(session_id, request)
        except MarkerAgentNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except MarkerAgentError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post(
        "/api/summary-agent-sessions/{session_id}/messages",
        response_model=AgentRun,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def create_summary_agent_message(
        session_id: str, request: SummaryAgentMessageRequest
    ) -> AgentRun:
        try:
            return summary_manager.create_agent_message(session_id, request)
        except SummaryRevisionConflictError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except SummaryError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.get("/api/agent-runs/{run_id}/events")
    async def agent_run_events(
        run_id: str,
        last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
    ) -> StreamingResponse:
        try:
            summary_manager.generic_agent_run(run_id)
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        after_sequence = 0
        if last_event_id:
            source_event_id = last_event_id.removesuffix("-proposal")
            previous_event = next(
                (
                    event
                    for event in summary_manager.agent_run_events(run_id)
                    if event.event_id == source_event_id
                ),
                None,
            )
            if previous_event is not None:
                after_sequence = previous_event.sequence

        async def stream_events():
            sequence = after_sequence
            while True:
                events = summary_manager.agent_run_events(run_id, sequence)
                for event in events:
                    sequence = event.sequence
                    event_name, payload = _public_agent_event(event)
                    if event_name:
                        yield _sse_event(
                            event_name,
                            {
                                "event_id": event.event_id,
                                "sequence": event.sequence,
                                **payload,
                            },
                            event.event_id,
                        )
                    result = event.payload.get("result")
                    if (
                        event.event_type == AgentEventType.TOOL_RESULT
                        and event.payload.get("name")
                        in {"propose_summary_change", "propose_marker_changes"}
                        and isinstance(result, dict)
                        and result.get("ok") is True
                    ):
                        yield _sse_event(
                            "proposal",
                            {
                                "event_id": f"{event.event_id}-proposal",
                                "sequence": event.sequence,
                                "proposal": result["proposal"],
                            },
                            f"{event.event_id}-proposal",
                        )
                run_state = summary_manager.generic_agent_run(run_id)
                if (
                    run_state.stage
                    in {
                        AgentRunStage.COMPLETE,
                        AgentRunStage.FAILED,
                        AgentRunStage.CANCELLED,
                        AgentRunStage.INTERRUPTED,
                    }
                    and not events
                ):
                    terminal_event = {
                        AgentRunStage.COMPLETE: "complete",
                        AgentRunStage.CANCELLED: "cancelled",
                    }.get(run_state.stage, "error")
                    yield _sse_event(
                        terminal_event,
                        {
                            "event_id": f"{run_id}-{terminal_event}",
                            "sequence": sequence + 1,
                            "run_id": run_id,
                            "message": run_state.error_message,
                        },
                        f"{run_id}-{terminal_event}",
                    )
                    break
                await asyncio.sleep(0.1)

        return StreamingResponse(stream_events(), media_type="text/event-stream")

    @app.post("/api/agent-runs/{run_id}/cancel", response_model=AgentRun)
    def cancel_agent_run(run_id: str) -> AgentRun:
        try:
            run = summary_manager.generic_agent_run(run_id)
            session = library.load_agent_session(run.session_id)
            if session and session.agent_type == "marker":
                return marker_agent_manager.cancel_agent_run(run_id)
            return summary_manager.cancel_agent_run(run_id)
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except MarkerAgentNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.post(
        "/api/marker-proposals/{proposal_id}/accept",
        response_model=MarkerProposal,
    )
    def accept_marker_proposal(proposal_id: str) -> MarkerProposal:
        try:
            return marker_agent_manager.accept_proposal(proposal_id)
        except MarkerProposalConflictError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except MarkerAgentNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except MarkerAgentError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post(
        "/api/marker-proposals/{proposal_id}/reject",
        response_model=MarkerProposal,
    )
    def reject_marker_proposal(proposal_id: str) -> MarkerProposal:
        try:
            return marker_agent_manager.reject_proposal(proposal_id)
        except MarkerAgentNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

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
    marker_agent_manager: MarkerAgentManager | None,
) -> None:
    if (
        (manager and manager.has_active_jobs())
        or (analysis_manager and analysis_manager.has_active_jobs())
        or (agent_manager and agent_manager.has_active_jobs())
        or (summary_manager and summary_manager.has_active_jobs())
        or (marker_agent_manager and marker_agent_manager.has_active_jobs())
    ):
        _library_error(
            409, "library_has_active_tasks", "存在运行中的任务，暂时无法切换资料库"
        )


async def _stop_asset_tasks(
    asset_ids: set[str],
    manager: DownloadManager | None,
    analysis_manager: AnalysisManager | None,
    agent_manager: AgentManager | None,
    summary_manager: SummaryManager | None,
    marker_agent_manager: MarkerAgentManager | None,
) -> None:
    """永久删除只能在所有关联执行器确认停止后继续，避免后台写回已删除目录。"""
    if not asset_ids:
        return
    cancellers = [
        candidate.cancel_assets(asset_ids)
        for candidate in (
            manager,
            analysis_manager,
            agent_manager,
            summary_manager,
            marker_agent_manager,
        )
        if candidate is not None
    ]
    try:
        results = await asyncio.gather(*cancellers)
    except Exception as error:
        raise HTTPException(
            status_code=409,
            detail="关联任务无法停止，未删除任何内容",
        ) from error
    if not all(results):
        raise HTTPException(
            status_code=409,
            detail="关联任务无法停止，未删除任何内容",
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


def _ready_asset(library: MediaLibrary, asset_id: str):
    try:
        asset = library.get(asset_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail="媒体资源不存在") from error
    if not asset or asset.status != MediaAssetStatus.READY:
        raise HTTPException(status_code=404, detail="媒体资源不存在")
    return asset


def _validate_marker_bounds(
    start_seconds: float,
    end_seconds: float | None,
    duration_seconds: float | None,
) -> None:
    if end_seconds is not None and end_seconds <= start_seconds:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="范围标记的结束时间必须晚于开始时间",
        )
    if duration_seconds is not None and (
        start_seconds > duration_seconds
        or (end_seconds is not None and end_seconds > duration_seconds)
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
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


def _public_agent_event(event) -> tuple[str | None, dict[str, object]]:
    event_names = {
        AgentEventType.RUN_STATUS: "status",
        AgentEventType.ASSISTANT_CHUNK: "assistant_chunk",
        AgentEventType.ASSISTANT_MESSAGE: "assistant_message",
        AgentEventType.TOOL_CALL: "tool_call",
        AgentEventType.TOOL_RESULT: "tool_result",
    }
    return event_names.get(event.event_type), dict(event.payload)


def _sse_event(event: str, payload: object, event_id: str | None = None) -> str:
    identifier = f"id: {event_id}\n" if event_id else ""
    return (
        f"{identifier}event: {event}\n"
        f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
    )


app = create_app()
