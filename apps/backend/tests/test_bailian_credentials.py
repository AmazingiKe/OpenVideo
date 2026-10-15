import traceback

import pytest
from keyring.backend import KeyringBackend
from keyring.errors import KeyringError, PasswordDeleteError

from openvideo import bailian_credentials
from openvideo.bailian_credentials import (
    BAILIAN_KEYRING_SERVICE,
    BailianCredentialError,
    BailianCredentialStore,
)
from openvideo.core.bailian_models import (
    BailianAsrConfiguration,
    BailianAsrPatch,
    BailianAsrStatus,
    BailianRegion,
)


class MemoryKeyringBackend(KeyringBackend):
    priority = 1

    def __init__(self) -> None:
        self.credentials: dict[tuple[str, str], str] = {}

    def get_password(self, service: str, username: str) -> str | None:
        return self.credentials.get((service, username))

    def set_password(self, service: str, username: str, password: str) -> None:
        self.credentials[(service, username)] = password

    def delete_password(self, service: str, username: str) -> None:
        if (service, username) not in self.credentials:
            raise PasswordDeleteError("未保存凭据")
        del self.credentials[(service, username)]


class FailingKeyringBackend(KeyringBackend):
    priority = 1

    def get_password(self, service: str, username: str) -> str | None:
        raise KeyringError("读取失败，敏感内容：sk-private-secret")

    def set_password(self, service: str, username: str, password: str) -> None:
        raise KeyringError(f"写入失败，敏感内容：{password}")

    def delete_password(self, service: str, username: str) -> None:
        raise KeyringError("删除失败，敏感内容：sk-private-secret")


def test_configuration_serializes_region_without_credentials_or_endpoint():
    configuration = BailianAsrConfiguration()

    assert configuration.region == BailianRegion.BEIJING
    assert configuration.base_url == "https://dashscope.aliyuncs.com/api/v1"
    assert configuration.model_dump(mode="json") == {"region": "beijing"}
    assert BailianAsrConfiguration(region=BailianRegion.SINGAPORE).base_url == (
        "https://dashscope-intl.aliyuncs.com/api/v1"
    )
    assert BailianAsrStatus(api_key_configured=True).model_dump(mode="json") == {
        "region": "beijing",
        "api_key_configured": True,
    }
    assert "sk-private-secret" not in repr(BailianAsrPatch(api_key="sk-private-secret"))


def test_keyring_credentials_are_trimmed_and_isolated_by_region():
    backend = MemoryKeyringBackend()
    store = BailianCredentialStore(keyring_backend=backend)

    assert store.get_api_key(BailianRegion.BEIJING) is None
    store.set_api_key(BailianRegion.BEIJING, "  sk-beijing  ")
    store.set_api_key(BailianRegion.SINGAPORE, "sk-singapore")

    assert store.require_api_key(BailianRegion.BEIJING) == "sk-beijing"
    assert store.get_api_key(BailianRegion.SINGAPORE) == "sk-singapore"
    assert backend.credentials == {
        (BAILIAN_KEYRING_SERVICE, "beijing"): "sk-beijing",
        (BAILIAN_KEYRING_SERVICE, "singapore"): "sk-singapore",
    }


def test_whitespace_deletes_only_the_selected_region_and_allows_repeated_clear():
    backend = MemoryKeyringBackend()
    store = BailianCredentialStore(backend)
    store.set_api_key(BailianRegion.BEIJING, "sk-beijing")
    store.set_api_key(BailianRegion.SINGAPORE, "sk-singapore")

    store.set_api_key(BailianRegion.BEIJING, " \n\t")
    store.set_api_key(BailianRegion.BEIJING, "")

    assert store.get_api_key(BailianRegion.BEIJING) is None
    assert store.get_api_key(BailianRegion.SINGAPORE) == "sk-singapore"
    with pytest.raises(BailianCredentialError, match="当前地域"):
        store.require_api_key(BailianRegion.BEIJING)


@pytest.mark.parametrize("operation", ["read", "save", "delete"])
def test_system_keyring_failures_are_reported_without_secret_or_exception_chain(
    operation,
):
    store = BailianCredentialStore(FailingKeyringBackend())

    with pytest.raises(BailianCredentialError, match="系统凭据库") as captured:
        if operation == "read":
            store.get_api_key(BailianRegion.BEIJING)
        elif operation == "save":
            store.set_api_key(BailianRegion.BEIJING, "sk-private-secret")
        else:
            store.set_api_key(BailianRegion.BEIJING, "")

    assert "sk-private-secret" not in str(captured.value)
    assert captured.value.__cause__ is None
    assert captured.value.__suppress_context__ is True
    assert "敏感内容" not in "".join(traceback.format_exception(captured.value))


def test_failed_delete_keeps_the_existing_credential_and_reports_failure(monkeypatch):
    backend = MemoryKeyringBackend()
    store = BailianCredentialStore(backend)
    store.set_api_key(BailianRegion.BEIJING, "sk-private-secret")

    def deny_delete(service: str, username: str) -> None:
        raise PasswordDeleteError("删除失败：sk-private-secret")

    monkeypatch.setattr(backend, "delete_password", deny_delete)

    with pytest.raises(BailianCredentialError, match="删除") as captured:
        store.set_api_key(BailianRegion.BEIJING, "")

    assert store.get_api_key(BailianRegion.BEIJING) == "sk-private-secret"
    assert "sk-private-secret" not in str(captured.value)


def test_default_store_uses_system_keyring_without_creating_configuration_files(
    monkeypatch, tmp_path
):
    backend = MemoryKeyringBackend()
    monkeypatch.setattr(bailian_credentials.keyring, "get_keyring", lambda: backend)
    monkeypatch.chdir(tmp_path)
    store = BailianCredentialStore()

    store.set_api_key(BailianRegion.BEIJING, "sk-system")

    assert store.get_api_key(BailianRegion.BEIJING) == "sk-system"
    assert list(tmp_path.iterdir()) == []


def test_backend_discovery_failure_is_sanitized(monkeypatch):
    def fail_to_discover_backend():
        raise RuntimeError("sk-private-secret")

    monkeypatch.setattr(
        bailian_credentials.keyring, "get_keyring", fail_to_discover_backend
    )

    with pytest.raises(BailianCredentialError, match="系统凭据库") as captured:
        BailianCredentialStore().get_api_key(BailianRegion.BEIJING)

    assert "sk-private-secret" not in str(captured.value)
