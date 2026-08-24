from pathlib import Path
from uuid import UUID

import pytest

from openvideo import download_accounts
from openvideo.core.media_models import SourcePlatform
from openvideo.download_accounts import (
    DownloadAccountExpired,
    DownloadAccountStatus,
    DownloadAccountStore,
    SystemDownloadAccountSecretStore,
    _platform_cookie_header_from_devtools,
    _platform_cookie_header_from_netscape_file,
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


@pytest.mark.parametrize(
    ("platform", "cookie_header", "expected_cookie_line"),
    [
        (
            SourcePlatform.BILIBILI,
            "SESSDATA=login-token; bili_jct=csrf-token; unrelated=discarded",
            ".bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tlogin-token",
        ),
        (
            SourcePlatform.DOUYIN,
            "ttwid=device-token; sessionid=login-token; unrelated=discarded",
            ".douyin.com\tTRUE\t/\tTRUE\t0\tsessionid\tlogin-token",
        ),
        (
            SourcePlatform.YOUTUBE,
            "SAPISID=login-token; PREF=language-token; unrelated=discarded",
            ".youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tlogin-token",
        ),
    ],
)
def test_platform_cookie_is_kept_out_of_the_account_manifest(
    tmp_path: Path,
    platform: SourcePlatform,
    cookie_header: str,
    expected_cookie_line: str,
):
    secrets = MemoryDownloadAccountSecretStore()
    store = DownloadAccountStore(tmp_path, secrets)

    account = store.save(platform, cookie_header)

    assert account.account_id.startswith("account-")
    account_uuid = UUID(hex=account.account_id.removeprefix("account-"))
    assert account_uuid.version == 7
    assert account.status == DownloadAccountStatus.UNTESTED
    assert "login-token" not in store.path.read_text(encoding="utf-8")
    assert "unrelated" not in secrets.secrets[account.account_id]

    with store.cookie_file(platform) as cookie_path:
        assert cookie_path is not None
        cookie_file = cookie_path.read_text(encoding="utf-8")
        assert "# Netscape HTTP Cookie File" in cookie_file
        assert expected_cookie_line in cookie_file
    assert not cookie_path.exists()


def test_relogin_replaces_cookie_without_changing_account_id(tmp_path: Path):
    secrets = MemoryDownloadAccountSecretStore()
    store = DownloadAccountStore(tmp_path, secrets)
    original = store.save(SourcePlatform.DOUYIN, "sessionid=first-token")
    store.mark_expired(SourcePlatform.DOUYIN)

    refreshed = store.save(SourcePlatform.DOUYIN, "sessionid=second-token")

    assert refreshed.account_id == original.account_id
    assert refreshed.status == DownloadAccountStatus.UNTESTED
    assert secrets.secrets[original.account_id] == "sessionid=second-token"


def test_expired_account_requires_relogin_before_cookie_use(tmp_path: Path):
    store = DownloadAccountStore(tmp_path, MemoryDownloadAccountSecretStore())
    store.save(SourcePlatform.DOUYIN, "sessionid=login-token")
    store.mark_expired(SourcePlatform.DOUYIN)

    with pytest.raises(DownloadAccountExpired, match="重新登录"):
        with store.cookie_file(SourcePlatform.DOUYIN):
            pass


def test_browser_cookie_filter_uses_the_selected_platform_domains(tmp_path: Path):
    cookie_path = tmp_path / "cookies.txt"
    cookie_path.write_text(
        "\n".join(
            [
                "# Netscape HTTP Cookie File",
                "#HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tbili-token",
                ".douyin.com\tTRUE\t/\tTRUE\t0\tsessionid\tdouyin-token",
                ".youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tyoutube-token",
                ".google.com\tTRUE\t/\tTRUE\t0\tSID\tgoogle-token",
            ]
        ),
        encoding="utf-8",
    )

    assert (
        _platform_cookie_header_from_netscape_file(
            SourcePlatform.BILIBILI,
            cookie_path,
        )
        == "SESSDATA=bili-token"
    )
    assert (
        _platform_cookie_header_from_netscape_file(
            SourcePlatform.DOUYIN,
            cookie_path,
        )
        == "sessionid=douyin-token"
    )
    assert (
        _platform_cookie_header_from_netscape_file(
            SourcePlatform.YOUTUBE,
            cookie_path,
        )
        == "SAPISID=youtube-token; SID=google-token"
    )


def test_dedicated_browser_cookie_filter_keeps_only_target_platform_fields():
    raw_cookies = [
        {"domain": ".bilibili.com", "name": "SESSDATA", "value": "bili-token"},
        {"domain": ".bilibili.com", "name": "unrelated", "value": "discarded"},
        {"domain": ".douyin.com", "name": "sessionid", "value": "douyin-token"},
        {"domain": ".example.com", "name": "SESSDATA", "value": "foreign-token"},
    ]

    assert (
        _platform_cookie_header_from_devtools(
            SourcePlatform.BILIBILI,
            raw_cookies,
        )
        == "SESSDATA=bili-token"
    )
    assert (
        _platform_cookie_header_from_devtools(
            SourcePlatform.YOUTUBE,
            raw_cookies,
        )
        == ""
    )

def test_system_secret_store_splits_large_cookie_for_windows_credentials(monkeypatch):
    credentials: dict[tuple[str, str], str] = {}

    def get_password(service: str, account_id: str) -> str | None:
        return credentials.get((service, account_id))

    def set_password(service: str, account_id: str, secret: str) -> None:
        credentials[(service, account_id)] = secret

    def delete_password(service: str, account_id: str) -> None:
        credentials.pop((service, account_id), None)

    monkeypatch.setattr(download_accounts.keyring, "get_password", get_password)
    monkeypatch.setattr(download_accounts.keyring, "set_password", set_password)
    monkeypatch.setattr(download_accounts.keyring, "delete_password", delete_password)
    store = SystemDownloadAccountSecretStore()
    account_id = "account-0198d12345677890abcdef1234567890"
    cookie_secret = "x" * 2_500

    store.save(account_id, cookie_secret)

    assert store.load(account_id) == cookie_secret
    assert len(credentials) == 4

    store.delete(account_id)

    assert credentials == {}
