from pathlib import Path

import httpx
import pytest

from openvideo.tools.vision import OpenAiCompatibleVision, VisionDescriptionError


class _FakeResponse:
    def __init__(self, content: str) -> None:
        self._content = content

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return {"choices": [{"message": {"content": self._content}}]}


def test_describe_returns_content(tmp_path: Path, monkeypatch):
    captured: dict = {}
    frame = tmp_path / "frame.jpg"
    frame.write_bytes(b"fake-image")

    def fake_post(url, **kwargs):
        captured["url"] = url
        captured["json"] = kwargs["json"]
        return _FakeResponse("这是一段画面描述")

    monkeypatch.setattr(httpx, "post", fake_post)
    describer = OpenAiCompatibleVision("https://api.example.com/v1", "secret", "gpt-5.6-terra")

    result = describer.describe(frame, "请描述画面")

    assert result == "这是一段画面描述"
    assert captured["url"] == "https://api.example.com/v1/chat/completions"
    assert captured["json"]["model"] == "gpt-5.6-terra"


def test_describe_requires_existing_frame(tmp_path: Path):
    describer = OpenAiCompatibleVision("https://api.example.com/v1", "secret", "model")

    with pytest.raises(VisionDescriptionError, match="关键帧不存在"):
        describer.describe(tmp_path / "missing.jpg", "请描述画面")
