from __future__ import annotations

from types import SimpleNamespace

import pytest

from openvideo.core.ai_models import AiModelConfiguration
from openvideo.llm.errors import FeatureCombinationUnsupportedError
from openvideo.llm.probes import (
    probe_basic_tools,
    probe_named_tool_choice,
    probe_streaming_tools,
    probe_vision_tools,
)
from openvideo.tools import llm


def model() -> AiModelConfiguration:
    return AiModelConfiguration(
        name="DeepSeek V4",
        litellm_model="deepseek/deepseek-v4-flash-vision-exp",
        api_key="secret",
        api_base="https://api.deepseek.com",
        input_modalities=["text", "image"],
    )


def tool_response(name: str = "report_probe") -> SimpleNamespace:
    function = SimpleNamespace(name=name, arguments='{"status":"ok"}')
    tool_call = SimpleNamespace(function=function)
    message = SimpleNamespace(tool_calls=[tool_call])
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def test_deepseek_non_thinking_tool_call(monkeypatch):
    captured: dict[str, object] = {}

    def completion(**request):
        captured.update(request)
        return tool_response()

    monkeypatch.setattr("openvideo.llm.probes.litellm.completion", completion)

    probe_basic_tools(model(), 30)

    assert captured["thinking"] == {"type": "disabled"}
    assert captured["tool_choice"] == "auto"
    assert "stream" not in captured


def test_deepseek_thinking_does_not_force_named_tool(monkeypatch):
    captured: dict[str, object] = {}

    def completion(**request):
        captured.update(request)
        raise RuntimeError("Thinking mode does not support this tool_choice")

    monkeypatch.setattr("openvideo.llm.probes.litellm.completion", completion)

    with pytest.raises(FeatureCombinationUnsupportedError):
        probe_named_tool_choice(model(), 30)

    assert captured["thinking"] == {"type": "disabled"}


def test_streaming_tool_call(monkeypatch):
    function = SimpleNamespace(name="report_probe", arguments='{"status":"ok"}')
    tool_call = SimpleNamespace(function=function)
    delta = SimpleNamespace(tool_calls=[tool_call])
    chunk = SimpleNamespace(choices=[SimpleNamespace(delta=delta)])
    monkeypatch.setattr(
        "openvideo.llm.probes.litellm.completion",
        lambda **_request: iter([chunk]),
    )

    probe_streaming_tools(model(), 30)


def test_vision_with_tools(monkeypatch):
    captured: dict[str, object] = {}
    vision_model = model()

    def completion(**request):
        captured.update(request)
        return tool_response()

    monkeypatch.setattr("openvideo.llm.probes.litellm.completion", completion)
    monkeypatch.setitem(
        llm._vision_transport_models,
        llm._vision_transport_cache_key(vision_model),
        "openai/deepseek-v4-flash-vision-exp",
    )

    probe_vision_tools(vision_model, 30)

    content = captured["messages"][0]["content"]
    assert any(part["type"] == "image_url" for part in content)
    assert captured["tool_choice"] == "auto"
    assert captured["model"] == "openai/deepseek-v4-flash-vision-exp"
    assert captured["extra_body"] == {"thinking": {"type": "disabled"}}
    assert "thinking" not in captured


def test_probe_retries_rate_limit_before_receiving_response(monkeypatch):
    attempts = 0
    delays: list[float] = []

    def completion(**_request):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("429 too many requests")
        return tool_response()

    monkeypatch.setattr("openvideo.llm.probes.litellm.completion", completion)
    monkeypatch.setattr("openvideo.llm.probes.defer_model_requests", delays.append)

    probe_basic_tools(model(), 30)

    assert attempts == 2
    assert delays == [1.0]


def test_streaming_probe_does_not_retry_after_first_chunk(monkeypatch):
    attempts = 0
    function = SimpleNamespace(name="report_probe", arguments='{"status":"ok"}')
    tool_call = SimpleNamespace(function=function)
    delta = SimpleNamespace(tool_calls=[tool_call])
    chunk = SimpleNamespace(choices=[SimpleNamespace(delta=delta)])

    def completion(**_request):
        nonlocal attempts
        attempts += 1

        def stream():
            yield chunk
            raise RuntimeError("429 rate limit")

        return stream()

    monkeypatch.setattr("openvideo.llm.probes.litellm.completion", completion)

    with pytest.raises(Exception, match="429 rate limit"):
        probe_streaming_tools(model(), 30)

    assert attempts == 1
