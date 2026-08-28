from collections.abc import Callable
from enum import StrEnum
from threading import Event
from uuid import UUID
import asyncio
import re

from fastapi import FastAPI, HTTPException, Response, status
from pydantic import BaseModel, Field, SecretStr, field_validator

from openvideo.core.identifiers import uuid7
from openvideo.core.media_models import SourcePlatform
from openvideo.download_accounts import (
    DownloadAccount,
    DownloadAccountError,
    DownloadAccountExpired,
    DownloadAccountLoginCancelled,
    DownloadAccountStore,
    DownloadCookieBrowser,
    import_cookie_from_browser,
)
from openvideo.tools.downloader import (
    DownloadFailure,
    is_authentication_failure,
    read_download_metadata,
)
from openvideo.tools.sources import UnsupportedSourceError, resolve_source


DOWNLOAD_ACCOUNT_TEST_URLS = {
    SourcePlatform.BILIBILI: "https://www.bilibili.com/video/BV1xx411c7mD",
    SourcePlatform.DOUYIN: "https://www.douyin.com/video/6961737553342991651",
    SourcePlatform.YOUTUBE: "https://www.youtube.com/watch?v=BaW_jenozKc",
}
DOWNLOAD_ACCOUNT_LOGIN_ID_PATTERN = re.compile(r"^login-[0-9a-f]{32}$")


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


def download_account_test_url(
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


class DownloadAccountLoginManager:
    """管理专用浏览器登录任务，确保取消信号和后台任务按会话成对释放。"""

    def __init__(
        self,
        account_store: DownloadAccountStore,
        capture_account_login: Callable[[SourcePlatform, Event], str],
    ) -> None:
        self.account_store = account_store
        self.capture_account_login = capture_account_login
        self.sessions: dict[str, DownloadAccountLoginSession] = {}
        self.cancellations: dict[str, Event] = {}
        self.tasks: dict[str, asyncio.Task[None]] = {}

    async def create(self, platform: SourcePlatform) -> DownloadAccountLoginSession:
        stale_login_ids = [
            login_id
            for login_id, session in self.sessions.items()
            if session.platform == platform
            and session.stage != DownloadAccountLoginStage.WAITING
        ]
        for login_id in stale_login_ids:
            self._discard(login_id)
        active_session = next(
            (
                session
                for session in self.sessions.values()
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
        self.sessions[login_id] = session
        self.cancellations[login_id] = cancel_event
        self.tasks[login_id] = asyncio.create_task(
            self._run(login_id, platform, cancel_event)
        )
        return session.model_copy(deep=True)

    def get(self, login_id: str) -> DownloadAccountLoginSession:
        session = self.sessions.get(login_id)
        if session is None:
            raise HTTPException(status_code=404, detail="账号登录会话不存在")
        return session.model_copy(deep=True)

    async def delete(self, login_id: str) -> None:
        if login_id not in self.sessions:
            raise HTTPException(status_code=404, detail="账号登录会话不存在")
        self.cancellations[login_id].set()
        await self.tasks[login_id]
        self._discard(login_id)

    async def close(self) -> None:
        for cancel_event in self.cancellations.values():
            cancel_event.set()
        if self.tasks:
            await asyncio.gather(*self.tasks.values(), return_exceptions=True)

    def _discard(self, login_id: str) -> None:
        self.sessions.pop(login_id, None)
        self.cancellations.pop(login_id, None)
        self.tasks.pop(login_id, None)

    async def _run(
        self,
        login_id: str,
        platform: SourcePlatform,
        cancel_event: Event,
    ) -> None:
        try:
            cookie_header = await asyncio.to_thread(
                self.capture_account_login,
                platform,
                cancel_event,
            )
            if cancel_event.is_set():
                raise DownloadAccountLoginCancelled("账号登录已取消")
            self.account_store.save(platform, cookie_header)
            with self.account_store.cookie_file(platform) as cookie_source:
                assert cookie_source is not None
                await asyncio.to_thread(
                    read_download_metadata,
                    DOWNLOAD_ACCOUNT_TEST_URLS[platform],
                    platform,
                    cookie_source,
                )
            account = self.account_store.mark_available(platform)
            assert account is not None
            self.sessions[login_id] = DownloadAccountLoginSession(
                login_id=login_id,
                platform=platform,
                stage=DownloadAccountLoginStage.COMPLETE,
                message="登录成功",
                account=account,
            )
        except DownloadAccountLoginCancelled as error:
            self.sessions[login_id] = DownloadAccountLoginSession(
                login_id=login_id,
                platform=platform,
                stage=DownloadAccountLoginStage.CANCELLED,
                message=str(error),
            )
        except DownloadFailure as error:
            if is_authentication_failure(error):
                self.account_store.mark_expired(platform)
            self.sessions[login_id] = DownloadAccountLoginSession(
                login_id=login_id,
                platform=platform,
                stage=DownloadAccountLoginStage.FAILED,
                message=str(error) or "无法验证账号登录状态",
            )
        except DownloadAccountError as error:
            self.sessions[login_id] = DownloadAccountLoginSession(
                login_id=login_id,
                platform=platform,
                stage=DownloadAccountLoginStage.FAILED,
                message=str(error),
            )


def register_download_account_routes(
    app: FastAPI,
    account_store: DownloadAccountStore,
    login_manager: DownloadAccountLoginManager,
) -> None:
    @app.get("/api/download-accounts", response_model=list[DownloadAccount])
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
    async def create_login_session(
        platform: SourcePlatform,
    ) -> DownloadAccountLoginSession:
        return await login_manager.create(platform)

    @app.get(
        "/api/download-account-login-sessions/{login_id}",
        response_model=DownloadAccountLoginSession,
    )
    async def get_login_session(login_id: str) -> DownloadAccountLoginSession:
        return login_manager.get(login_id)

    @app.delete(
        "/api/download-account-login-sessions/{login_id}",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    async def delete_login_session(login_id: str) -> Response:
        await login_manager.delete(login_id)
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

    @app.put("/api/download-accounts/{platform}", response_model=DownloadAccount)
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
        test_url = download_account_test_url(platform, request.source_url)
        try:
            cookie_header = await asyncio.to_thread(
                import_cookie_from_browser,
                platform,
                request.browser,
                test_url,
            )
            account_store.save(platform, cookie_header)
            account = account_store.mark_available(platform)
            assert account is not None
            return account
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
        if account_store.get(platform) is None:
            raise HTTPException(status_code=404, detail="尚未连接该平台账号")
        test_url = download_account_test_url(platform, request.source_url)
        try:
            with account_store.cookie_file(platform) as cookie_source:
                assert cookie_source is not None
                await asyncio.to_thread(
                    read_download_metadata,
                    test_url,
                    platform,
                    cookie_source,
                )
            account = account_store.mark_available(platform)
            assert account is not None
            return account
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
