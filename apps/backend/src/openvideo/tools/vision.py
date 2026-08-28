"""通过 LiteLLM 为时间轴关键帧补充视觉描述。"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Protocol

from openvideo.core.ai_models import AiModelConfiguration
from openvideo.tools.llm import LlmCompletionError, complete_text


DEFAULT_DESCRIBE_TIMEOUT_SECONDS = 120


class VisionDescriptionError(RuntimeError):
    """视觉模型无法返回画面描述时抛出。"""


class VisionDescriber(Protocol):
    """可插拔的画面描述实现，统一返回自然语言描述。"""

    def describe(self, image_paths: list[Path], prompt: str) -> str:
        ...


class LiteLlmVision:
    """把项目的多帧提示转换为 LiteLLM 支持的多模态消息。"""

    def __init__(self, model: AiModelConfiguration) -> None:
        self.model = model

    def describe(self, image_paths: list[Path], prompt: str) -> str:
        if not image_paths:
            raise VisionDescriptionError("至少需要一张关键帧")
        image_messages: list[dict[str, object]] = []
        for index, image_path in enumerate(image_paths, start=1):
            image_messages.extend(
                (
                    {"type": "text", "text": f"候选画面 {index}"},
                    {
                        "type": "image_url",
                        "image_url": {"url": _image_data_url(image_path)},
                    },
                )
            )
        messages: list[dict[str, object]] = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    *image_messages,
                ],
            }
        ]
        try:
            return complete_text(
                self.model,
                messages,
                DEFAULT_DESCRIBE_TIMEOUT_SECONDS,
            )
        except LlmCompletionError as error:
            raise VisionDescriptionError(str(error)) from error


def _image_data_url(image_path: Path) -> str:
    if not image_path.is_file():
        raise VisionDescriptionError(f"关键帧不存在：{image_path}")
    encoded = base64.b64encode(image_path.read_bytes()).decode()
    return f"data:image/jpeg;base64,{encoded}"
