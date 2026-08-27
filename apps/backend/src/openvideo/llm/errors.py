from __future__ import annotations


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


THINKING_TOOL_CHOICE_ERROR = "thinking mode does not support this tool_choice"
TOOL_UNSUPPORTED_MARKERS = (
    "does not support tools",
    "doesn't support tools",
    "function calling is not supported",
    "tool calling is not supported",
    "unsupported parameter: tools",
)


def classify_provider_error(error: Exception) -> LlmRuntimeError:
    message = str(error)
    normalized_message = message.lower()
    if THINKING_TOOL_CHOICE_ERROR in normalized_message:
        return FeatureCombinationUnsupportedError(message)
    if any(marker in normalized_message for marker in TOOL_UNSUPPORTED_MARKERS):
        return ToolCallingUnsupportedError(message)
    return ProviderRequestError(message)
