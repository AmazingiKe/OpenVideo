from __future__ import annotations

import json
import os
import re
import tempfile
from contextlib import contextmanager
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from threading import RLock
from typing import Iterator, Protocol
from uuid import UUID

import keyring
from keyring.errors import KeyringError
from pydantic import BaseModel, Field, ValidationError, field_validator

from openvideo.configuration import OPENVIDEO_CONFIG_DIRECTORY
from openvideo.core.identifiers import uuid7
from openvideo.core.models import SourcePlatform


DOWNLOAD_ACCOUNTS_FILE_NAME = "download_accounts.json"
DOWNLOAD_ACCOUNTS_FORMAT_VERSION = 1
DOWNLOAD_ACCOUNT_KEYRING_SERVICE = "OpenVideo 下载账号"
DOUYIN_COOKIE_DOMAIN = ".douyin.com"
DOUYIN_COOKIE_PATH = "/"
MAX_COOKIE_SECRET_BYTES = 1_200
COOKIE_NAME_PATTERN = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
DOWNLOAD_ACCOUNT_ID_PATTERN = re.compile(r"^account-[0-9a-f]{32}$")
DOUYIN_AUTHENTICATION_COOKIE_NAMES = frozenset(
    {"sessionid", "sessionid_ss", "sid_tt", "uid_tt", "uid_tt_ss"}
)
DOUYIN_SESSION_COOKIE_NAMES = frozenset(
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
)


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


class DownloadAccountSecretStore(Protocol):
    def load(self, account_id: str) -> str | None: ...

    def save(self, account_id: str, cookie_secret: str) -> None: ...

    def delete(self, account_id: str) -> None: ...


class SystemDownloadAccountSecretStore:
    """下载 Cookie 属于账号凭据，因此交给操作系统凭据库而不是配置文件明文保存。"""

    def load(self, account_id: str) -> str | None:
        try:
            return keyring.get_password(DOWNLOAD_ACCOUNT_KEYRING_SERVICE, account_id)
        except KeyringError as error:
            raise DownloadAccountError("无法从系统凭据库读取登录状态") from error

    def save(self, account_id: str, cookie_secret: str) -> None:
        try:
            keyring.set_password(
                DOWNLOAD_ACCOUNT_KEYRING_SERVICE,
                account_id,
                cookie_secret,
            )
        except KeyringError as error:
            raise DownloadAccountError("无法将登录状态保存到系统凭据库") from error

    def delete(self, account_id: str) -> None:
        try:
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

    def save_douyin(self, cookie_header: str) -> DownloadAccount:
        cookie_secret = _normalized_douyin_cookie_secret(cookie_header)
        with self._lock:
            manifest = self._load_manifest()
            account = next(
                (
                    item
                    for item in manifest.accounts
                    if item.platform == SourcePlatform.DOUYIN
                ),
                None,
            )
            previous_secret = (
                self.secret_store.load(account.account_id) if account else None
            )
            if account is None:
                account = DownloadAccount(
                    account_id=f"account-{uuid7().hex}",
                    platform=SourcePlatform.DOUYIN,
                    display_name="抖音账号",
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
        if account.status == DownloadAccountStatus.EXPIRED:
            raise DownloadAccountExpired("抖音登录状态已过期，请重新登录")
        cookie_secret = self.secret_store.load(account.account_id)
        if not cookie_secret:
            self.mark_expired(platform)
            raise DownloadAccountExpired("保存的抖音登录状态已丢失，请重新登录")
        self.directory.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix=".download-account-",
            dir=self.directory,
        ) as temporary_directory:
            cookie_path = Path(temporary_directory) / "cookies.txt"
            cookie_path.write_text(
                _netscape_cookie_file(cookie_secret),
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


def _normalized_douyin_cookie_secret(cookie_header: str) -> str:
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
        if name in DOUYIN_SESSION_COOKIE_NAMES:
            cookies[name] = value
    if not DOUYIN_AUTHENTICATION_COOKIE_NAMES.intersection(cookies):
        raise DownloadAccountError("未找到抖音登录 Cookie，请确认网页账号已经登录")
    cookie_secret = "; ".join(
        f"{name}={value}" for name, value in sorted(cookies.items())
    )
    if len(cookie_secret.encode("utf-8")) > MAX_COOKIE_SECRET_BYTES:
        raise DownloadAccountError("抖音登录 Cookie 过长，无法安全保存")
    return cookie_secret


def _netscape_cookie_file(cookie_secret: str) -> str:
    lines = ["# Netscape HTTP Cookie File"]
    for raw_cookie in cookie_secret.split(";"):
        name, _, value = raw_cookie.strip().partition("=")
        lines.append(
            "\t".join(
                [
                    DOUYIN_COOKIE_DOMAIN,
                    "TRUE",
                    DOUYIN_COOKIE_PATH,
                    "TRUE",
                    "0",
                    name,
                    value,
                ]
            )
        )
    return "\n".join(lines) + "\n"
