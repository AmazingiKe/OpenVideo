from pathlib import Path
from types import SimpleNamespace

import pytest

from openvideo.core.ai_models import AiModelConfiguration
from openvideo.tools import llm
from openvideo.tools.vision import LiteLlmVision, VisionDescriptionError


MODEL_ID = "model-01890f4c7a2b7cc298c4dc0c0c07398f"


def test_describe_returns_content(tmp_path: Path, monkeypatch):
    captured: dict = {}
    frame = tmp_path / "frame.jpg"
    frame.write_bytes(b"fake-image")

    def fake_completion(**kwargs):
        captured.update(kwargs)
        message = SimpleNamespace(content="这是一段画面描述")
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    monkeypatch.setattr(llm.litellm, "completion", fake_completion)
    describer = LiteLlmVision(
        AiModelConfiguration(
            model_id=MODEL_ID,
            name="视觉模型",
            litellm_model="openai/gpt-5.6-terra",
            api_base="https://api.example.com/v1",
            api_key="secret",
            input_modalities=["text", "image"],
        )
    )

    result = describer.describe([frame], "请描述画面")

    assert result == "这是一段画面描述"
    assert captured["api_base"] == "https://api.example.com/v1"
    assert captured["model"] == "openai/gpt-5.6-terra"
    assert captured["api_key"] == "secret"
    content = captured["messages"][0]["content"]
    assert content[1] == {"type": "text", "text": "候选画面 1"}
    assert content[2]["type"] == "image_url"


def test_describe_requires_existing_frame(tmp_path: Path):
    describer = LiteLlmVision(
        AiModelConfiguration(
            model_id=MODEL_ID,
            name="视觉模型",
            litellm_model="openai/model",
        )
    )

    with pytest.raises(VisionDescriptionError, match="关键帧不存在"):
        describer.describe([tmp_path / "missing.jpg"], "请描述画面")
