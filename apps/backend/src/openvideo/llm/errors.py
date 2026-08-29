from __future__ import annotations

from datetime import UTC, datetime
from email.utils import parsedate_to_datetime


class LlmRuntimeError(RuntimeError):
    """模型调用失败时保留可供运行层判断的稳定分类。"""


class ToolCallingUnsupportedError(LlmRuntimeError):
    """供应商明确拒绝工具协议，而非目录尚未识别模型。"""


class FeatureCombinationUnsupportedError(LlmRuntimeError):
    """单项能力可用，但当前 Thinking 与工具参数组合不可用。"""


class ModelCapabilityUnknownError(LlmRuntimeError):
    """调用方明确要求已确认能力，但解析结果仍无证据。"""


class ProviderRequestError(LlmRuntimeError):
    """认证、限流、网络或未分类供应商错误不应伪装成能力缺失。"""


class TransientProviderRequestError(ProviderRequestError):
    """限流与暂时服务故障允许在无副作用阶段做有限退避重试。"""

    def __init__(
        self,
        message: str,
        retry_after_seconds: float | None = None,
    ) -> None:
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds


THINKING_TOOL_CHOICE_ERROR = "thinking mode does not support this tool_choice"
TOOL_UNSUPPORTED_MARKERS = (
    "does not support tools",
    "doesn't support tools",
    "function calling is not supported",
    "tool calling is not supported",
    "unsupported parameter: tools",
)
TRANSIENT_STATUS_CODES = frozenset({408, 409, 425, 429, 500, 502, 503, 504})
TRANSIENT_ERROR_MARKERS = (
    "429",
    "connection reset",
    "rate limit",
    "temporarily unavailable",
    "timed out",
    "timeout",
    "too many requests",
)
MAX_PROVIDER_REQUEST_RETRIES = 2
PROVIDER_RETRY_BASE_DELAY_SECONDS = 1.0


def classify_provider_error(error: Exception) -> LlmRuntimeError:
    message = str(error)
    normalized_message = message.lower()
    if THINKING_TOOL_CHOICE_ERROR in normalized_message:
        return FeatureCombinationUnsupportedError(message)
    if any(marker in normalized_message for marker in TOOL_UNSUPPORTED_MARKERS):
        return ToolCallingUnsupportedError(message)
    status_code = getattr(error, "status_code", None)
    try:
        status_code = int(status_code)
    except (TypeError, ValueError):
        status_code = None
    if status_code in TRANSIENT_STATUS_CODES or any(
        marker in normalized_message for marker in TRANSIENT_ERROR_MARKERS
    ):
        return TransientProviderRequestError(
            message,
            retry_after_seconds=_retry_after_seconds(error),
        )
    return ProviderRequestError(message)


def _retry_after_seconds(error: Exception) -> float | None:
    response = getattr(error, "response", None)
    headers = getattr(response, "headers", None) or getattr(error, "headers", None)
    if headers is None:
        return None
    retry_after = headers.get("retry-after") or headers.get("Retry-After")
    try:
        return max(0.0, float(retry_after))
    except (TypeError, ValueError):
        pass
    try:
        retry_at = parsedate_to_datetime(str(retry_after))
    except (TypeError, ValueError, OverflowError):
        return None
    if retry_at.tzinfo is None:
        retry_at = retry_at.replace(tzinfo=UTC)
    return max(0.0, (retry_at - datetime.now(UTC)).total_seconds())


def provider_retry_delay_seconds(
    error: TransientProviderRequestError,
    attempt: int,
) -> float:
    """供应商给出的冷却时间优先于本地指数退避，避免过早重试。"""

    exponential_delay = PROVIDER_RETRY_BASE_DELAY_SECONDS * (2**attempt)
    return max(exponential_delay, error.retry_after_seconds or 0.0)
