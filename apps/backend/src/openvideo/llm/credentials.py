from __future__ import annotations

import logging
import os
import traceback
from threading import RLock
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

if TYPE_CHECKING:
    from openvideo.core.ai_models import AiModelConfiguration


ENVIRONMENT_KEY_PREFIX = "env:"
DEEPSEEK_KEY_ENVIRONMENT = "DEEPSEEK_API_KEY"
DEEPSEEK_API_HOST = "api.deepseek.com"
DEFAULT_DEEPSEEK_API_BASE = "https://api.deepseek.com"
REDACTED_MODEL_SECRET = "[已隐藏]"
_resolved_secrets: set[str] = set()
_secret_lock = RLock()
_log_redaction_installed = False


class ModelCredentialError(ValueError):
    """显式环境引用不可用时必须停止，不能退回 SDK 隐式凭据。"""


def resolve_model_api_key(model: AiModelConfiguration) -> str | None:
    """仅在请求边界读取凭据，模型配置与持久化数据始终保留引用。"""

    configured_key = model.api_key
    if (
        not configured_key
        and model.litellm_model.partition("/")[0].casefold() == "deepseek"
    ):
        raise ModelCredentialError("请为 DeepSeek 填写 API 密钥或 env:DEEPSEEK_API_KEY")
    if not configured_key or not configured_key.startswith(ENVIRONMENT_KEY_PREFIX):
        if configured_key:
            _protect_model_secret(configured_key)
        return configured_key
    environment_name = configured_key.removeprefix(ENVIRONMENT_KEY_PREFIX)
    if environment_name != DEEPSEEK_KEY_ENVIRONMENT:
        raise ModelCredentialError("环境密钥引用仅支持 env:DEEPSEEK_API_KEY")
    if not _uses_deepseek_origin(model):
        raise ModelCredentialError(
            "环境密钥 DEEPSEEK_API_KEY 仅可用于官方 DeepSeek HTTPS 地址"
        )
    value = os.getenv(environment_name)
    if value is None or not value.strip():
        raise ModelCredentialError("未设置后端环境变量 DEEPSEEK_API_KEY")
    value = value.strip()
    _protect_model_secret(value)
    return value


def _uses_deepseek_origin(model: AiModelConfiguration) -> bool:
    if model.litellm_model.partition("/")[0].casefold() != "deepseek":
        return False
    if model.api_base is None:
        return True
    try:
        endpoint = urlsplit(model.api_base)
        return (
            endpoint.scheme == "https"
            and endpoint.hostname == DEEPSEEK_API_HOST
            and endpoint.port in (None, 443)
            and endpoint.username is None
            and endpoint.password is None
            and endpoint.path.rstrip("/") in ("", "/v1")
            and not endpoint.query
            and not endpoint.fragment
        )
    except ValueError:
        return False


def redact_model_secrets(message: str) -> str:
    """覆盖已解析凭据及轮换前值，避免并发请求的旧错误泄露密钥。"""

    with _secret_lock:
        secrets = sorted(_resolved_secrets, key=len, reverse=True)
    for secret in secrets:
        message = message.replace(secret, REDACTED_MODEL_SECRET)
    return message


def _protect_model_secret(secret: str) -> None:
    global _log_redaction_installed
    with _secret_lock:
        _resolved_secrets.add(secret)
        if _log_redaction_installed:
            return
        previous_factory = logging.getLogRecordFactory()

        def redacted_record(*args, **kwargs) -> logging.LogRecord:
            # SDK 会在抛出异常前记录日志，因此必须先于各自的日志处理器脱敏。
            record = previous_factory(*args, **kwargs)
            record.msg = _redact_log_value(record.msg)
            record.args = _redact_log_value(record.args)
            if record.exc_info:
                record.exc_text = redact_model_secrets(
                    "".join(traceback.format_exception(*record.exc_info))
                )
                record.exc_info = None
            if record.stack_info:
                record.stack_info = redact_model_secrets(record.stack_info)
            return record

        logging.setLogRecordFactory(redacted_record)
        _log_redaction_installed = True


def _redact_log_value(value):
    """保留 Uvicorn 等结构化日志格式器依赖的参数形状。"""

    if isinstance(value, str):
        return redact_model_secrets(value)
    if isinstance(value, tuple):
        return tuple(_redact_log_value(item) for item in value)
    if isinstance(value, list):
        return [_redact_log_value(item) for item in value]
    if isinstance(value, dict):
        return {
            _redact_log_value(key): _redact_log_value(item)
            for key, item in value.items()
        }
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return redact_model_secrets(str(value))
