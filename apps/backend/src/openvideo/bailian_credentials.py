"""百炼调用凭据由操作系统保管，避免随偏好文件或资料库泄露。"""

from __future__ import annotations

import keyring
from keyring.backend import KeyringBackend

from openvideo.core.bailian_models import BailianRegion


BAILIAN_KEYRING_SERVICE = "OpenVideo 阿里云百炼"
KEYRING_READ_ERROR = "无法从系统凭据库读取百炼 API Key，请检查系统凭据库是否可用"
KEYRING_SAVE_ERROR = "无法将百炼 API Key 保存到系统凭据库，请检查系统凭据库是否可用"
KEYRING_DELETE_ERROR = "无法从系统凭据库删除百炼 API Key，请检查系统凭据库是否可用"
MISSING_API_KEY_ERROR = "请先在设置中保存当前地域的阿里云百炼 API Key"


class BailianCredentialError(RuntimeError):
    pass


class BailianCredentialStore:
    """按服务地域隔离密钥，系统凭据库不可用时阻止云端转写。"""

    def __init__(self, keyring_backend: KeyringBackend | None = None) -> None:
        self._keyring_backend = keyring_backend

    def get_api_key(self, region: BailianRegion) -> str | None:
        try:
            backend = self._keyring_backend or keyring.get_keyring()
            api_key = backend.get_password(BAILIAN_KEYRING_SERVICE, region.value)
        except Exception:  # noqa: BLE001 - 系统后端异常必须统一脱敏。
            # 系统后端的异常可能包含凭据，不保留其消息或异常链。
            raise BailianCredentialError(KEYRING_READ_ERROR) from None
        if api_key is None:
            return None
        return api_key.strip() or None

    def set_api_key(self, region: BailianRegion, api_key: str) -> None:
        cleaned_api_key = api_key.strip()
        error_message = KEYRING_SAVE_ERROR if cleaned_api_key else KEYRING_DELETE_ERROR
        try:
            backend = self._keyring_backend or keyring.get_keyring()
            if cleaned_api_key:
                backend.set_password(
                    BAILIAN_KEYRING_SERVICE, region.value, cleaned_api_key
                )
            elif (
                backend.get_password(BAILIAN_KEYRING_SERVICE, region.value) is not None
            ):
                backend.delete_password(BAILIAN_KEYRING_SERVICE, region.value)
        except Exception:  # noqa: BLE001 - 系统后端异常必须统一脱敏。
            raise BailianCredentialError(error_message) from None

    def require_api_key(self, region: BailianRegion) -> str:
        """云端任务在上传音频前必须确认当前地域具备可用凭据。"""
        api_key = self.get_api_key(region)
        if api_key is None:
            raise BailianCredentialError(MISSING_API_KEY_ERROR)
        return api_key
