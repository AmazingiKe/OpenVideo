from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from threading import Event, RLock
from typing import Iterator, Protocol
from uuid import UUID

import keyring
from keyring.errors import KeyringError
from pydantic import BaseModel, Field, ValidationError, field_validator
from websockets.exceptions import WebSocketException
from websockets.sync.client import ClientConnection, connect

from openvideo.configuration import OPENVIDEO_CONFIG_DIRECTORY
from openvideo.core.identifiers import uuid7
from openvideo.core.media_models import SourcePlatform


DOWNLOAD_ACCOUNTS_FILE_NAME = "download_accounts.json"
DOWNLOAD_ACCOUNTS_FORMAT_VERSION = 1
DOWNLOAD_ACCOUNT_KEYRING_SERVICE = "OpenVideo 下载账号"
COOKIE_PATH = "/"
MAX_COOKIE_SECRET_BYTES = 12_000
COOKIE_IMPORT_TIMEOUT_SECONDS = 180
BROWSER_LOGIN_TIMEOUT_SECONDS = 300
BROWSER_START_TIMEOUT_SECONDS = 15
BROWSER_COOKIE_POLL_SECONDS = 1
BROWSER_LOGIN_SETTLE_SECONDS = 2
BROWSER_SHUTDOWN_TIMEOUT_SECONDS = 5
DEVTOOLS_ACTIVE_PORT_FILE_NAME = "DevToolsActivePort"
OPENVIDEO_BROWSER_LOGIN_DIRECTORY_NAME = "browser-login"
KEYRING_SECRET_CHUNK_CHARACTERS = 1_000
KEYRING_SECRET_CHUNK_MARKER = "openvideo-cookie-chunks:"
COOKIE_NAME_PATTERN = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
DOWNLOAD_ACCOUNT_ID_PATTERN = re.compile(r"^account-[0-9a-f]{32}$")
PLATFORM_LOGIN_URLS = {
    SourcePlatform.BILIBILI: "https://passport.bilibili.com/login",
    SourcePlatform.DOUYIN: "https://www.douyin.com/",
    SourcePlatform.YOUTUBE: "https://www.youtube.com/",
}


@dataclass(frozen=True)
class PlatformAccountConfiguration:
    display_name: str
    cookie_domain: str
    cookie_domains: frozenset[str]
    authentication_cookie_names: frozenset[str]
    session_cookie_names: frozenset[str]


PLATFORM_ACCOUNT_CONFIGURATIONS = {
    SourcePlatform.BILIBILI: PlatformAccountConfiguration(
        display_name="Bilibili 账号",
        cookie_domain=".bilibili.com",
        cookie_domains=frozenset({"bilibili.com"}),
        authentication_cookie_names=frozenset({"SESSDATA"}),
        session_cookie_names=frozenset(
            {
                "DedeUserID",
                "DedeUserID__ckMd5",
                "SESSDATA",
                "b_nut",
                "bili_jct",
                "buvid3",
                "buvid4",
                "sid",
            }
        ),
    ),
    SourcePlatform.DOUYIN: PlatformAccountConfiguration(
        display_name="抖音账号",
        cookie_domain=".douyin.com",
        cookie_domains=frozenset({"douyin.com"}),
        authentication_cookie_names=frozenset(
            {"sessionid", "sessionid_ss", "sid_tt", "uid_tt", "uid_tt_ss"}
        ),
        session_cookie_names=frozenset(
            {
                "__ac_nonce",
                "__ac_signature",
                "install_id",
                "login_time",
                "msToken",
                "odin_tt",
                "passport_assist_user",
                "passport_csrf_token",
                "passport_csrf_token_default",
                "s_v_web_id",
                "sessionid",
                "sessionid_ss",
                "sid_guard",
                "sid_tt",
                "sid_ucp_v1",
                "ssid_ucp_v1",
                "store-region",
                "store-region-src",
                "ttwid",
                "uid_tt",
                "uid_tt_ss",
            }
        ),
    ),
    SourcePlatform.YOUTUBE: PlatformAccountConfiguration(
        display_name="YouTube 账号",
        cookie_domain=".youtube.com",
        cookie_domains=frozenset({"google.com", "youtube.com"}),
        authentication_cookie_names=frozenset(
            {
                "APISID",
                "LOGIN_INFO",
                "SAPISID",
                "SID",
                "__Secure-1PAPISID",
                "__Secure-3PAPISID",
            }
        ),
        session_cookie_names=frozenset(
            {
                "APISID",
                "HSID",
                "LOGIN_INFO",
                "PREF",
                "SAPISID",
                "SID",
                "SSID",
                "VISITOR_INFO1_LIVE",
                "VISITOR_PRIVACY_METADATA",
                "YSC",
                "__Secure-1PAPISID",
                "__Secure-1PSID",
                "__Secure-3PAPISID",
                "__Secure-3PSID",
            }
        ),
    ),
}


class DownloadAccountStatus(StrEnum):
    UNTESTED = "untested"
    AVAILABLE = "available"
    EXPIRED = "expired"


class DownloadCookieBrowser(StrEnum):
    EDGE = "edge"
    CHROME = "chrome"
    FIREFOX = "firefox"


class DownloadAccount(BaseModel):
    account_id: str
    platform: SourcePlatform
    display_name: str
    status: DownloadAccountStatus = DownloadAccountStatus.UNTESTED
    last_tested_at: datetime | None = None
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @field_validator("account_id")
    @classmethod
    def validate_account_id(cls, account_id: str) -> str:
        if not DOWNLOAD_ACCOUNT_ID_PATTERN.fullmatch(account_id):
            raise ValueError("下载账号 ID 格式无效")
        account_uuid = UUID(hex=account_id.removeprefix("account-"))
        if account_uuid.version != 7:
            raise ValueError("下载账号 ID 必须使用 UUIDv7")
        return account_id


class DownloadAccountManifest(BaseModel):
    format_version: int = DOWNLOAD_ACCOUNTS_FORMAT_VERSION
    accounts: list[DownloadAccount] = Field(default_factory=list)


class DownloadAccountError(RuntimeError):
    pass


class DownloadAccountExpired(DownloadAccountError):
    pass


class DownloadAccountLoginCancelled(DownloadAccountError):
    pass


class DownloadAccountSecretStore(Protocol):
    def load(self, account_id: str) -> str | None: ...

    def save(self, account_id: str, cookie_secret: str) -> None: ...

    def delete(self, account_id: str) -> None: ...


def _keyring_secret_chunk_count(stored_secret: str | None) -> int:
    if not stored_secret or not stored_secret.startswith(KEYRING_SECRET_CHUNK_MARKER):
        return 0
    raw_chunk_count = stored_secret.removeprefix(KEYRING_SECRET_CHUNK_MARKER)
    if not raw_chunk_count.isdigit() or int(raw_chunk_count) < 2:
        raise DownloadAccountError("系统凭据库中的登录状态格式无效")
    return int(raw_chunk_count)


def _keyring_chunk_account_id(account_id: str, index: int) -> str:
    return f"{account_id}-chunk-{index}"


class SystemDownloadAccountSecretStore:
    """下载 Cookie 属于账号凭据，因此交给操作系统凭据库而不是配置文件明文保存。"""

    def load(self, account_id: str) -> str | None:
        try:
            stored_secret = keyring.get_password(
                DOWNLOAD_ACCOUNT_KEYRING_SERVICE,
                account_id,
            )
            chunk_count = _keyring_secret_chunk_count(stored_secret)
            if chunk_count == 0:
                return stored_secret
            chunks = [
                keyring.get_password(
                    DOWNLOAD_ACCOUNT_KEYRING_SERVICE,
                    _keyring_chunk_account_id(account_id, index),
                )
                for index in range(chunk_count)
            ]
            if any(chunk is None for chunk in chunks):
                raise DownloadAccountError("系统凭据库中的登录状态不完整")
            return "".join(chunk for chunk in chunks if chunk is not None)
        except KeyringError as error:
            raise DownloadAccountError("无法从系统凭据库读取登录状态") from error

    def save(self, account_id: str, cookie_secret: str) -> None:
        try:
            previous_secret = keyring.get_password(
                DOWNLOAD_ACCOUNT_KEYRING_SERVICE,
                account_id,
            )
            previous_chunk_count = _keyring_secret_chunk_count(previous_secret)
            chunks = [
                cookie_secret[index : index + KEYRING_SECRET_CHUNK_CHARACTERS]
                for index in range(
                    0, len(cookie_secret), KEYRING_SECRET_CHUNK_CHARACTERS
                )
            ]
            if len(chunks) == 1:
                keyring.set_password(
                    DOWNLOAD_ACCOUNT_KEYRING_SERVICE,
                    account_id,
                    chunks[0],
                )
            else:
                for index, chunk in enumerate(chunks):
                    keyring.set_password(
                        DOWNLOAD_ACCOUNT_KEYRING_SERVICE,
                        _keyring_chunk_account_id(account_id, index),
                        chunk,
                    )
                keyring.set_password(
                    DOWNLOAD_ACCOUNT_KEYRING_SERVICE,
                    account_id,
                    f"{KEYRING_SECRET_CHUNK_MARKER}{len(chunks)}",
                )
            first_obsolete_chunk = 0 if len(chunks) == 1 else len(chunks)
            for index in range(first_obsolete_chunk, previous_chunk_count):
                try:
                    keyring.delete_password(
                        DOWNLOAD_ACCOUNT_KEYRING_SERVICE,
                        _keyring_chunk_account_id(account_id, index),
                    )
                except keyring.errors.PasswordDeleteError:
                    continue
        except KeyringError as error:
            raise DownloadAccountError("无法将登录状态保存到系统凭据库") from error

    def delete(self, account_id: str) -> None:
        try:
            stored_secret = keyring.get_password(
                DOWNLOAD_ACCOUNT_KEYRING_SERVICE,
                account_id,
            )
            for index in range(_keyring_secret_chunk_count(stored_secret)):
                try:
                    keyring.delete_password(
                        DOWNLOAD_ACCOUNT_KEYRING_SERVICE,
                        _keyring_chunk_account_id(account_id, index),
                    )
                except keyring.errors.PasswordDeleteError:
                    continue
            keyring.delete_password(DOWNLOAD_ACCOUNT_KEYRING_SERVICE, account_id)
        except keyring.errors.PasswordDeleteError:
            return
        except KeyringError as error:
            raise DownloadAccountError("无法从系统凭据库删除登录状态") from error


class DownloadAccountStore:
    """账号清单与敏感 Cookie 分开保存，界面只能读取不含凭据的状态摘要。"""

    def __init__(
        self,
        directory: Path | None = None,
        secret_store: DownloadAccountSecretStore | None = None,
    ) -> None:
        self.directory = directory or OPENVIDEO_CONFIG_DIRECTORY
        self.path = self.directory / DOWNLOAD_ACCOUNTS_FILE_NAME
        self.secret_store = secret_store or SystemDownloadAccountSecretStore()
        self._lock = RLock()

    def get(self, platform: SourcePlatform) -> DownloadAccount | None:
        with self._lock:
            account = next(
                (
                    item
                    for item in self._load_manifest().accounts
                    if item.platform == platform
                ),
                None,
            )
            return account.model_copy(deep=True) if account else None

    def list_accounts(self) -> list[DownloadAccount]:
        with self._lock:
            return [
                account.model_copy(deep=True)
                for account in self._load_manifest().accounts
            ]

    def save(self, platform: SourcePlatform, cookie_header: str) -> DownloadAccount:
        configuration = PLATFORM_ACCOUNT_CONFIGURATIONS[platform]
        cookie_secret = _normalized_cookie_secret(platform, cookie_header)
        with self._lock:
            manifest = self._load_manifest()
            account = next(
                (item for item in manifest.accounts if item.platform == platform),
                None,
            )
            previous_secret = (
                self.secret_store.load(account.account_id) if account else None
            )
            if account is None:
                account = DownloadAccount(
                    account_id=f"account-{uuid7().hex}",
                    platform=platform,
                    display_name=configuration.display_name,
                )
                manifest.accounts.append(account)
            else:
                account.status = DownloadAccountStatus.UNTESTED
                account.last_tested_at = None
                account.updated_at = datetime.now(UTC)
            self.secret_store.save(account.account_id, cookie_secret)
            try:
                self._save_manifest(manifest)
            except Exception:
                if previous_secret is None:
                    self.secret_store.delete(account.account_id)
                else:
                    self.secret_store.save(account.account_id, previous_secret)
                raise
            return account.model_copy(deep=True)

    def mark_available(self, platform: SourcePlatform) -> DownloadAccount | None:
        return self._update_status(platform, DownloadAccountStatus.AVAILABLE)

    def mark_expired(self, platform: SourcePlatform) -> DownloadAccount | None:
        return self._update_status(platform, DownloadAccountStatus.EXPIRED)

    def delete(self, platform: SourcePlatform) -> None:
        with self._lock:
            manifest = self._load_manifest()
            account = next(
                (item for item in manifest.accounts if item.platform == platform),
                None,
            )
            if account is None:
                return
            self.secret_store.delete(account.account_id)
            manifest.accounts = [
                item
                for item in manifest.accounts
                if item.account_id != account.account_id
            ]
            self._save_manifest(manifest)

    @contextmanager
    def cookie_file(self, platform: SourcePlatform) -> Iterator[Path | None]:
        account = self.get(platform)
        if account is None:
            yield None
            return
        configuration = PLATFORM_ACCOUNT_CONFIGURATIONS[platform]
        if account.status == DownloadAccountStatus.EXPIRED:
            raise DownloadAccountExpired(
                f"{configuration.display_name}登录状态已过期，请重新登录"
            )
        cookie_secret = self.secret_store.load(account.account_id)
        if not cookie_secret:
            self.mark_expired(platform)
            raise DownloadAccountExpired(
                f"保存的{configuration.display_name}登录状态已丢失，请重新登录"
            )
        self.directory.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix=".download-account-",
            dir=self.directory,
        ) as temporary_directory:
            cookie_path = Path(temporary_directory) / "cookies.txt"
            cookie_path.write_text(
                _netscape_cookie_file(platform, cookie_secret),
                encoding="utf-8",
            )
            cookie_path.chmod(0o600)
            yield cookie_path

    def _update_status(
        self,
        platform: SourcePlatform,
        status: DownloadAccountStatus,
    ) -> DownloadAccount | None:
        with self._lock:
            manifest = self._load_manifest()
            account = next(
                (item for item in manifest.accounts if item.platform == platform),
                None,
            )
            if account is None:
                return None
            account.status = status
            account.last_tested_at = datetime.now(UTC)
            account.updated_at = account.last_tested_at
            self._save_manifest(manifest)
            return account.model_copy(deep=True)

    def _load_manifest(self) -> DownloadAccountManifest:
        if not self.path.is_file():
            return DownloadAccountManifest()
        try:
            manifest = DownloadAccountManifest.model_validate_json(
                self.path.read_text(encoding="utf-8")
            )
        except (OSError, ValidationError) as error:
            raise DownloadAccountError("无法读取下载账号配置") from error
        if manifest.format_version != DOWNLOAD_ACCOUNTS_FORMAT_VERSION:
            raise DownloadAccountError("下载账号配置版本不受支持")
        return manifest

    def _save_manifest(self, manifest: DownloadAccountManifest) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        temporary_path = self.path.with_name(f".{self.path.name}.tmp")
        try:
            temporary_path.write_text(
                json.dumps(
                    manifest.model_dump(mode="json"),
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            os.replace(temporary_path, self.path)
        except OSError as error:
            raise DownloadAccountError("无法保存下载账号配置") from error
        finally:
            temporary_path.unlink(missing_ok=True)


def import_cookie_from_browser(
    platform: SourcePlatform,
    browser: DownloadCookieBrowser,
    source_url: str,
) -> str:
    """浏览器 Cookie 只在临时目录导出，并仅保留目标平台下载所需的登录字段。"""
    configuration = PLATFORM_ACCOUNT_CONFIGURATIONS[platform]
    with tempfile.TemporaryDirectory(prefix="openvideo-browser-cookie-") as directory:
        cookie_path = Path(directory) / "cookies.txt"
        command = [
            sys.executable,
            "-m",
            "yt_dlp",
            "--ignore-config",
            "--no-warnings",
            "--skip-download",
            "--dump-single-json",
            "--cookies-from-browser",
            browser.value,
            "--cookies",
            str(cookie_path),
            source_url,
        ]
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                check=False,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=COOKIE_IMPORT_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as error:
            raise DownloadAccountError(
                "浏览器 Cookie 导入超时，请关闭浏览器后重试"
            ) from error
        diagnostic = result.stderr or result.stdout
        if result.returncode != 0:
            lowered = diagnostic.casefold()
            if (
                "could not copy" in lowered
                or "permission denied" in lowered
                or "database is locked" in lowered
            ):
                raise DownloadAccountError(
                    "无法读取浏览器 Cookie，请完全关闭该浏览器后重试"
                )
            raise DownloadAccountError(
                f"无法验证{configuration.display_name}登录状态，请重新登录后重试"
            )
        if not cookie_path.is_file():
            raise DownloadAccountError("浏览器没有导出可用的 Cookie")
        cookie_header = _platform_cookie_header_from_netscape_file(
            platform,
            cookie_path,
        )
        if not cookie_header:
            raise DownloadAccountError(
                f"该浏览器中没有找到{configuration.display_name}登录状态"
            )
        return cookie_header


def capture_cookie_from_dedicated_browser(
    platform: SourcePlatform,
    cancel_event: Event,
) -> str:
    """专用临时浏览器避免读取用户日常配置，也让应用能在浏览器运行时识别登录完成。"""
    browser_path = _dedicated_login_browser_path()
    login_directory = (
        OPENVIDEO_CONFIG_DIRECTORY / OPENVIDEO_BROWSER_LOGIN_DIRECTORY_NAME
    )
    login_directory.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f"{platform.value}-",
        dir=login_directory,
        ignore_cleanup_errors=True,
    ) as directory:
        profile_directory = Path(directory)
        process = _start_dedicated_login_browser(
            browser_path,
            profile_directory,
            PLATFORM_LOGIN_URLS[platform],
        )
        try:
            websocket_url = _wait_for_devtools_endpoint(
                profile_directory,
                process,
                cancel_event,
            )
            return _wait_for_platform_login_cookie(
                platform,
                websocket_url,
                process,
                cancel_event,
            )
        finally:
            _stop_dedicated_login_browser(process)


def _dedicated_login_browser_path() -> Path:
    candidates: list[Path] = []
    for command_name in ("msedge", "google-chrome", "chrome", "chromium"):
        command_path = shutil.which(command_name)
        if command_path:
            candidates.append(Path(command_path))
    if sys.platform == "win32":
        windows_locations = (
            ("PROGRAMFILES(X86)", "Microsoft/Edge/Application/msedge.exe"),
            ("PROGRAMFILES", "Microsoft/Edge/Application/msedge.exe"),
            ("LOCALAPPDATA", "Microsoft/Edge/Application/msedge.exe"),
            ("PROGRAMFILES", "Google/Chrome/Application/chrome.exe"),
            ("PROGRAMFILES(X86)", "Google/Chrome/Application/chrome.exe"),
            ("LOCALAPPDATA", "Google/Chrome/Application/chrome.exe"),
        )
        for environment_name, relative_path in windows_locations:
            root = os.getenv(environment_name)
            if root:
                candidates.append(Path(root) / relative_path)
    elif sys.platform == "darwin":
        candidates.extend(
            (
                Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
                Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
                Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
            )
        )
    browser_path = next((path for path in candidates if path.is_file()), None)
    if browser_path is None:
        raise DownloadAccountError(
            "未找到 Microsoft Edge、Google Chrome 或 Chromium，无法打开专用登录窗口"
        )
    return browser_path


def _start_dedicated_login_browser(
    browser_path: Path,
    profile_directory: Path,
    login_url: str,
) -> subprocess.Popen[bytes]:
    command = [
        str(browser_path),
        f"--user-data-dir={profile_directory}",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-mode",
        "--disable-sync",
        f"--app={login_url}",
    ]
    try:
        return subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError as error:
        raise DownloadAccountError("无法启动专用登录窗口") from error


def _wait_for_devtools_endpoint(
    profile_directory: Path,
    process: subprocess.Popen[bytes],
    cancel_event: Event,
) -> str:
    active_port_path = profile_directory / DEVTOOLS_ACTIVE_PORT_FILE_NAME
    deadline = time.monotonic() + BROWSER_START_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        _raise_if_browser_login_stopped(process, cancel_event)
        try:
            lines = active_port_path.read_text(encoding="utf-8").splitlines()
        except OSError:
            lines = []
        if len(lines) >= 2 and lines[0].isdigit() and lines[1].startswith("/"):
            return f"ws://127.0.0.1:{lines[0]}{lines[1]}"
        cancel_event.wait(0.1)
    raise DownloadAccountError("专用登录窗口启动超时")


def _wait_for_platform_login_cookie(
    platform: SourcePlatform,
    websocket_url: str,
    process: subprocess.Popen[bytes],
    cancel_event: Event,
) -> str:
    deadline = time.monotonic() + BROWSER_LOGIN_TIMEOUT_SECONDS
    request_id = 0
    login_detected_at: float | None = None
    try:
        with connect(
            websocket_url,
            origin=None,
            proxy=None,
            open_timeout=BROWSER_START_TIMEOUT_SECONDS,
            close_timeout=1,
        ) as websocket:
            while time.monotonic() < deadline:
                _raise_if_browser_login_stopped(process, cancel_event)
                request_id += 1
                websocket.send(
                    json.dumps(
                        {"id": request_id, "method": "Storage.getCookies"},
                        separators=(",", ":"),
                    )
                )
                response = _receive_devtools_response(websocket, request_id)
                result = response.get("result")
                raw_cookies = (
                    result.get("cookies", []) if isinstance(result, dict) else []
                )
                cookie_header = _platform_cookie_header_from_devtools(
                    platform,
                    raw_cookies if isinstance(raw_cookies, list) else [],
                )
                if cookie_header:
                    if login_detected_at is None:
                        login_detected_at = time.monotonic()
                    elif (
                        time.monotonic() - login_detected_at
                        >= BROWSER_LOGIN_SETTLE_SECONDS
                    ):
                        return cookie_header
                else:
                    login_detected_at = None
                cancel_event.wait(BROWSER_COOKIE_POLL_SECONDS)
    except DownloadAccountLoginCancelled:
        raise
    except (OSError, TimeoutError, WebSocketException) as error:
        raise DownloadAccountError("无法读取专用登录窗口的登录状态") from error
    raise DownloadAccountError("等待网页登录超时，请重新连接账号")


def _receive_devtools_response(
    websocket: ClientConnection,
    request_id: int,
) -> dict[str, object]:
    while True:
        raw_message = websocket.recv(timeout=BROWSER_START_TIMEOUT_SECONDS)
        try:
            message = json.loads(raw_message)
        except json.JSONDecodeError as error:
            raise DownloadAccountError(
                "浏览器返回的登录状态格式无效"
            ) from error
        if not isinstance(message, dict):
            raise DownloadAccountError("浏览器返回的登录状态格式无效")
        if message.get("id") != request_id:
            continue
        if "error" in message:
            raise DownloadAccountError("浏览器无法提供登录状态")
        return message


def _platform_cookie_header_from_devtools(
    platform: SourcePlatform,
    raw_cookies: list[object],
) -> str:
    configuration = PLATFORM_ACCOUNT_CONFIGURATIONS[platform]
    cookies: dict[str, str] = {}
    for raw_cookie in raw_cookies:
        if not isinstance(raw_cookie, dict):
            continue
        name = raw_cookie.get("name")
        value = raw_cookie.get("value")
        domain = raw_cookie.get("domain")
        if not all(isinstance(item, str) for item in (name, value, domain)):
            continue
        normalized_domain = domain.lstrip(".").casefold()
        domain_matches = any(
            normalized_domain == allowed_domain
            or normalized_domain.endswith(f".{allowed_domain}")
            for allowed_domain in configuration.cookie_domains
        )
        if domain_matches and name in configuration.session_cookie_names and value:
            cookies[name] = value
    authentication_found = configuration.authentication_cookie_names.intersection(
        cookies
    )
    if not authentication_found:
        return ""
    cookie_header = "; ".join(
        f"{name}={value}" for name, value in sorted(cookies.items())
    )
    return _normalized_cookie_secret(platform, cookie_header)


def _raise_if_browser_login_stopped(
    process: subprocess.Popen[bytes],
    cancel_event: Event,
) -> None:
    if cancel_event.is_set():
        raise DownloadAccountLoginCancelled("账号登录已取消")
    if process.poll() is not None:
        raise DownloadAccountError("登录窗口已关闭，尚未检测到有效登录状态")


def _stop_dedicated_login_browser(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=BROWSER_SHUTDOWN_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=BROWSER_SHUTDOWN_TIMEOUT_SECONDS)


def _normalized_cookie_secret(
    platform: SourcePlatform,
    cookie_header: str,
) -> str:
    configuration = PLATFORM_ACCOUNT_CONFIGURATIONS[platform]
    if "\r" in cookie_header or "\n" in cookie_header or "\t" in cookie_header:
        raise DownloadAccountError("Cookie 不能包含换行或制表符")
    normalized_header = cookie_header.strip()
    if normalized_header.casefold().startswith("cookie:"):
        normalized_header = normalized_header.split(":", 1)[1].strip()
    cookies: dict[str, str] = {}
    for raw_cookie in normalized_header.split(";"):
        name, separator, value = raw_cookie.strip().partition("=")
        if not separator or not COOKIE_NAME_PATTERN.fullmatch(name) or not value:
            continue
        if name in configuration.session_cookie_names:
            cookies[name] = value
    if not configuration.authentication_cookie_names.intersection(cookies):
        raise DownloadAccountError(
            f"未找到{configuration.display_name}登录 Cookie，请确认网页账号已经登录"
        )
    cookie_secret = "; ".join(
        f"{name}={value}" for name, value in sorted(cookies.items())
    )
    if len(cookie_secret.encode("utf-8")) > MAX_COOKIE_SECRET_BYTES:
        raise DownloadAccountError(
            f"{configuration.display_name}登录 Cookie 过长，无法安全保存"
        )
    return cookie_secret


def _platform_cookie_header_from_netscape_file(
    platform: SourcePlatform,
    cookie_path: Path,
) -> str:
    configuration = PLATFORM_ACCOUNT_CONFIGURATIONS[platform]
    cookies: list[str] = []
    for raw_line in cookie_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line.startswith("#HttpOnly_"):
            line = line.removeprefix("#HttpOnly_")
        elif not line or line.startswith("#"):
            continue
        fields = line.split("\t")
        if len(fields) != 7:
            continue
        domain, _, _, _, _, name, value = fields
        normalized_domain = domain.lstrip(".").casefold()
        if not any(
            normalized_domain == allowed_domain
            or normalized_domain.endswith(f".{allowed_domain}")
            for allowed_domain in configuration.cookie_domains
        ):
            continue
        if name in configuration.session_cookie_names:
            cookies.append(f"{name}={value}")
    return "; ".join(cookies)


def _netscape_cookie_file(
    platform: SourcePlatform,
    cookie_secret: str,
) -> str:
    configuration = PLATFORM_ACCOUNT_CONFIGURATIONS[platform]
    lines = ["# Netscape HTTP Cookie File"]
    for raw_cookie in cookie_secret.split(";"):
        name, _, value = raw_cookie.strip().partition("=")
        lines.append(
            "\t".join(
                [
                    configuration.cookie_domain,
                    "TRUE",
                    COOKIE_PATH,
                    "TRUE",
                    "0",
                    name,
                    value,
                ]
            )
        )
    return "\n".join(lines) + "\n"
