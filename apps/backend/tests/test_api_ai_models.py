from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from openvideo.core.ai_models import AiModelConfiguration
from openvideo.llm.errors import ToolCallingUnsupportedError
from openvideo.llm.capability_resolver import CapabilityResolver
from openvideo.llm.models_dev import ModelsDevCatalog
from openvideo.llm.probe_cache import ProbeCache
from openvideo.preferences import PreferenceStore
from openvideo.settings import Settings
from openvideo.tools.llm import LlmCompletionError
from openvideo.ui import ai_routes, api


MODEL_ID = "model-01890f4c7a2b7cc298c4dc0c0c07398f"
MODEL_REQUEST = {
    "model_id": MODEL_ID,
    "name": "测试模型",
    "litellm_model": "openai/test-model",
    "api_key": "secret",
    "api_base": "https://example.com/v1",
    "api_version": None,
    "input_modalities": ["text"],
}


@pytest.fixture(autouse=True)
def disable_models_dev_network(monkeypatch):
    monkeypatch.setattr(
        ModelsDevCatalog,
        "_download_model",
        lambda *_args: None,
    )


def pass_tool_probes(monkeypatch) -> None:
    for probe_name in (
        "probe_basic_tools",
        "probe_streaming_tools",
        "probe_named_tool_choice",
        "probe_parallel_tools",
        "probe_reasoning_tools",
        "probe_vision_tools",
    ):
        monkeypatch.setattr(ai_routes, probe_name, lambda *_args: None)


def create_client(tmp_path: Path) -> TestClient:
    preference_store = PreferenceStore(tmp_path / "config" / "preferences.json")
    resolver = CapabilityResolver(
        models_dev=ModelsDevCatalog(tmp_path / "config" / "models-dev.json"),
        probe_cache=ProbeCache(tmp_path / "config" / "probes.json"),
    )
    return TestClient(
        api.create_app(
            Settings(models_directory=str(tmp_path / "models")),
            preference_store,
            capability_resolver=resolver,
        )
    )


def test_ai_model_reports_availability_and_latency(tmp_path: Path, monkeypatch):
    captured_request: dict[str, object] = {}

    def complete_model(
        model,
        messages,
        timeout_seconds,
        max_tokens,
        disable_thinking,
    ):
        captured_request.update(
            model=model,
            messages=messages,
            timeout_seconds=timeout_seconds,
            max_tokens=max_tokens,
            disable_thinking=disable_thinking,
        )
        return "OK"

    timestamps = iter([10.0, 10.086])
    monkeypatch.setattr(ai_routes, "complete_text", complete_model)
    pass_tool_probes(monkeypatch)
    monkeypatch.setattr(ai_routes, "perf_counter", lambda: next(timestamps))

    with create_client(tmp_path) as client:
        response = client.post("/api/ai/models/test", json=MODEL_REQUEST)

    assert response.status_code == 200
    payload = response.json()
    assert payload["available"] is True
    assert payload["latency_ms"] == 86
    assert payload["message"] == "模型响应正常"
    assert payload["capabilities"]["text"]["support"] == "yes"
    assert payload["capabilities"]["tools"] == {
        "support": "yes",
        "source": "runtime_probe",
        "tested": True,
        "message": "基础工具调用正常",
    }
    assert payload["profile"]["capabilities"]["tools"] == "yes"
    assert payload["profile"]["capability_sources"]["tools"] == "runtime_probe"
    assert captured_request["model"].litellm_model == "openai/test-model"
    assert captured_request["messages"] == [
        {"role": "user", "content": "Reply only with OK."}
    ]
    assert captured_request["timeout_seconds"] == 30
    assert captured_request["max_tokens"] == 8
    assert captured_request["disable_thinking"] is True


def test_ai_model_test_rejects_local_inference_without_calling_provider(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setattr(
        ai_routes,
        "complete_text",
        lambda *_args, **_kwargs: pytest.fail("本地模型不应发起请求"),
    )
    request = {
        **MODEL_REQUEST,
        "litellm_model": "ollama/qwen2.5-vl",
        "api_base": "http://127.0.0.1:11434",
    }

    with create_client(tmp_path) as client:
        response = client.post("/api/ai/models/test", json=request)

    assert response.status_code == 422
    assert "仅支持在线 API" in response.json()["detail"]


def test_ai_model_returns_provider_failure_as_test_result(tmp_path: Path, monkeypatch):
    def reject_model(*_args, **_kwargs):
        raise LlmCompletionError("模型请求失败：密钥 secret 无法识别 LiteLLM 供应商")

    timestamps = iter([20.0, 20.024])
    monkeypatch.setattr(ai_routes, "complete_text", reject_model)
    monkeypatch.setattr(ai_routes, "perf_counter", lambda: next(timestamps))

    with create_client(tmp_path) as client:
        response = client.post("/api/ai/models/test", json=MODEL_REQUEST)

    assert response.status_code == 200
    payload = response.json()
    assert payload["available"] is False
    assert payload["latency_ms"] == 24
    assert payload["message"] == ("模型请求失败：密钥 [已隐藏] 无法识别 LiteLLM 供应商")
    assert payload["capabilities"]["text"]["support"] == "no"
    assert payload["capabilities"]["tools"]["support"] == "unknown"
    assert payload["capabilities"]["tools"]["tested"] is False


def test_ai_model_probes_declared_vision_and_reports_tool_failure(
    tmp_path: Path, monkeypatch
):
    request = {
        **MODEL_REQUEST,
        "input_modalities": ["text", "image"],
    }
    monkeypatch.setattr(
        ai_routes, "complete_text", lambda *_args, **_kwargs: "OK"
    )
    pass_tool_probes(monkeypatch)
    monkeypatch.setattr(
        ai_routes,
        "probe_basic_tools",
        lambda *_args: (_ for _ in ()).throw(
            ToolCallingUnsupportedError("供应商不支持 tools")
        ),
    )
    vision_calls = []
    monkeypatch.setattr(
        ai_routes,
        "probe_image_input",
        lambda model, timeout: vision_calls.append((model.model_id, timeout)),
    )

    with create_client(tmp_path) as client:
        response = client.post("/api/ai/models/test", json=request)

    assert response.status_code == 200
    assert response.json()["capabilities"]["tools"] == {
        "support": "no",
        "source": "runtime_probe",
        "tested": True,
        "message": "基础工具调用已确认不支持：供应商不支持 tools",
    }
    assert response.json()["capabilities"]["vision"]["support"] == "yes"
    assert vision_calls == [(MODEL_ID, 30)]


def test_preferences_patch_preserves_typed_ai_models(tmp_path: Path):
    with create_client(tmp_path) as client:
        updated = client.patch(
            "/api/preferences",
            json={"ai_models": [MODEL_REQUEST]},
        )
        listed = client.get("/api/ai/models")

    assert updated.status_code == 200
    assert listed.status_code == 200
    payload = listed.json()[0]
    assert payload["model_id"] == MODEL_ID
    assert payload["name"] == "测试模型"
    assert payload["litellm_model"] == "openai/test-model"
    assert payload["input_modalities"] == ["text"]
    assert payload["capabilities"]["tools"] == "auto"
    assert payload["profile"]["capabilities"]["tools"] == "unknown"


def test_preferences_patch_rejects_local_ai_models(tmp_path: Path):
    request = {
        **MODEL_REQUEST,
        "name": "本地模型",
        "litellm_model": "ollama/qwen2.5-vl",
        "api_base": "http://127.0.0.1:11434",
    }

    with create_client(tmp_path) as client:
        response = client.patch("/api/preferences", json={"ai_models": [request]})

    assert response.status_code == 422
    assert response.json()["detail"] == (
        "本地模型：大语言与视觉模型仅支持在线 API，不能使用本地推理供应商"
    )


def test_transcription_catalog_exposes_available_and_extension_models(tmp_path: Path):
    with create_client(tmp_path) as client:
        response = client.get("/api/transcription/models")

    assert response.status_code == 200
    models = {model["model"]: model for model in response.json()}
    assert models["large-v3-turbo"]["integration_status"] == "available"
    assert models["large-v3-turbo"]["installation_status"] == "not_installed"
    assert models["large-v3-turbo"]["repository"].endswith(
        "faster-whisper-large-v3-turbo"
    )
    assert models["qwen3-asr-1.7b"]["engine"] == "qwen3-asr"
    assert models["sensevoice-small"]["integration_status"] == "available"


def test_preferences_patch_persists_default_transcription(tmp_path: Path):
    store = PreferenceStore(tmp_path / "config" / "preferences.json")
    with TestClient(api.create_app(Settings(), store)) as client:
        response = client.patch(
            "/api/preferences",
            json={
                "default_transcription": {
                    "engine": "faster-whisper",
                    "model": "large-v3-turbo",
                    "language": "zh",
                    "device": "auto",
                    "compute_type": "auto",
                }
            },
        )

    assert response.status_code == 200
    assert response.json()["default_transcription"]["model"] == "large-v3-turbo"
    assert store.load().default_transcription.model == "large-v3-turbo"


def test_preferences_patch_persists_agent_roles_and_permission_mode(tmp_path: Path):
    store = PreferenceStore(tmp_path / "config" / "preferences.json")
    model = AiModelConfiguration.model_validate(MODEL_REQUEST)
    with TestClient(api.create_app(Settings(ai_models=[model]), store)) as client:
        response = client.patch(
            "/api/preferences",
            json={
                "agent": {
                    "permission_mode": "smart_approval",
                    "fast_model_id": MODEL_ID,
                    "complex_model_id": MODEL_ID,
                    "vision_model_id": MODEL_ID,
                    "default_thinking_mode": "auto",
                    "max_concurrent_runs": 6,
                }
            },
        )

    assert response.status_code == 200
    assert response.json()["agent"]["max_concurrent_runs"] == 6
    assert store.load().agent.fast_model_id == MODEL_ID


def test_preferences_patch_rejects_unregistered_agent_model_role(tmp_path: Path):
    store = PreferenceStore(tmp_path / "config" / "preferences.json")
    with TestClient(api.create_app(Settings(), store)) as client:
        response = client.patch(
            "/api/preferences",
            json={"agent": {"fast_model_id": MODEL_ID}},
        )

    assert response.status_code == 422
    assert response.json()["detail"] == "Agent 模型角色必须从已注册模型中选择"
