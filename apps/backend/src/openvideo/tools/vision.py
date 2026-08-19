"""可插拔的视觉描述能力。

画面分析统一走 OpenAI 兼容的 chat/completions 接口，base_url、模型与密钥
均可配置，因此能无缝切换官方 OpenAI 或任意兼容网关（如 Qwen、DeepSeek-VL）。
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Protocol

import httpx


DEFAULT_DESCRIBE_TIMEOUT_SECONDS = 120


class VisionDescriptionError(RuntimeError):
    """视觉模型无法返回画面描述时抛出。"""


class VisionDescriber(Protocol):
    """可插拔的画面描述实现，统一返回自然语言描述。"""

    def describe(self, image_path: Path, prompt: str) -> str:
        ...


class OpenAiCompatibleVision:
    """通过 OpenAI 兼容的 /chat/completions 接口描述单张图片。"""

    def __init__(self, base_url: str, api_key: str, model: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model

    def describe(self, image_path: Path, prompt: str) -> str:
        image_url = _image_data_url(image_path)
        payload = {
            "model": self.model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": image_url}},
                    ],
                }
            ],
        }
        try:
            response = httpx.post(
                f"{self.base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=DEFAULT_DESCRIBE_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except httpx.HTTPError as error:
            raise VisionDescriptionError(f"视觉模型请求失败：{error}") from error

        content = response.json().get("choices", [{}])[0].get("message", {}).get("content")
        if not isinstance(content, str) or not content.strip():
            raise VisionDescriptionError("视觉模型未返回有效描述")
        return content.strip()


def _image_data_url(image_path: Path) -> str:
    if not image_path.is_file():
        raise VisionDescriptionError(f"关键帧不存在：{image_path}")
    encoded = base64.b64encode(image_path.read_bytes()).decode()
    return f"data:image/jpeg;base64,{encoded}"
