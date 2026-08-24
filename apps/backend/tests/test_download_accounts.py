from pathlib import Path
from uuid import UUID

import pytest

from openvideo.core.models import SourcePlatform
from openvideo.download_accounts import (
    DownloadAccountExpired,
    DownloadAccountStatus,
    DownloadAccountStore,
)


class MemoryDownloadAccountSecretStore:
    def __init__(self) -> None:
        self.secrets: dict[str, str] = {}

    def load(self, account_id: str) -> str | None:
        return self.secrets.get(account_id)

    def save(self, account_id: str, cookie_secret: str) -> None:
        self.secrets[account_id] = cookie_secret

    def delete(self, account_id: str) -> None:
        self.secrets.pop(account_id, None)


def test_douyin_cookie_is_kept_out_of_the_account_manifest(tmp_path: Path):
    secrets = MemoryDownloadAccountSecretStore()
    store = DownloadAccountStore(tmp_path, secrets)

    account = store.save_douyin(
        "ttwid=device-token; sessionid=login-token; unrelated=discarded"
    )

    assert account.account_id.startswith("account-")
    account_uuid = UUID(hex=account.account_id.removeprefix("account-"))
    assert account_uuid.version == 7
    assert account.status == DownloadAccountStatus.UNTESTED
    assert "login-token" not in store.path.read_text(encoding="utf-8")
    assert secrets.secrets[account.account_id] == (
        "sessionid=login-token; ttwid=device-token"
    )

    with store.cookie_file(SourcePlatform.DOUYIN) as cookie_path:
        assert cookie_path is not None
        cookie_file = cookie_path.read_text(encoding="utf-8")
        assert "# Netscape HTTP Cookie File" in cookie_file
        assert ".douyin.com\tTRUE\t/\tTRUE\t0\tsessionid\tlogin-token" in cookie_file
    assert not cookie_path.exists()


def test_relogin_replaces_cookie_without_changing_account_id(tmp_path: Path):
    secrets = MemoryDownloadAccountSecretStore()
    store = DownloadAccountStore(tmp_path, secrets)
    original = store.save_douyin("sessionid=first-token")
    store.mark_expired(SourcePlatform.DOUYIN)

    refreshed = store.save_douyin("sessionid=second-token")

    assert refreshed.account_id == original.account_id
    assert refreshed.status == DownloadAccountStatus.UNTESTED
    assert secrets.secrets[original.account_id] == "sessionid=second-token"


def test_expired_account_requires_relogin_before_cookie_use(tmp_path: Path):
    store = DownloadAccountStore(tmp_path, MemoryDownloadAccountSecretStore())
    store.save_douyin("sessionid=login-token")
    store.mark_expired(SourcePlatform.DOUYIN)

    with pytest.raises(DownloadAccountExpired, match="重新登录"):
        with store.cookie_file(SourcePlatform.DOUYIN):
            pass
