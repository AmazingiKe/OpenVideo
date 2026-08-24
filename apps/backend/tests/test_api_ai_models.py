from pathlib import Path

from fastapi.testclient import TestClient

from openvideo.preferences import PreferenceStore
from openvideo.settings import Settings
from openvideo.tools.llm import LlmCompletionError
from openvideo.ui import api


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


def create_client(tmp_path: Path) -> TestClient:
    preference_store = PreferenceStore(tmp_path / "config" / "preferences.json")
    return TestClient(
        api.create_app(
            Settings(models_directory=str(tmp_path / "models")),
            preference_store,
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
    monkeypatch.setattr(api, "complete_text", complete_model)
    monkeypatch.setattr(api, "perf_counter", lambda: next(timestamps))

    with create_client(tmp_path) as client:
        response = client.post("/api/ai/models/test", json=MODEL_REQUEST)

    assert response.status_code == 200
    assert response.json() == {
        "available": True,
        "latency_ms": 86,
        "message": "模型响应正常",
    }
    assert captured_request["model"].litellm_model == "openai/test-model"
    assert captured_request["messages"] == [
        {"role": "user", "content": "Reply only with OK."}
    ]
    assert captured_request["timeout_seconds"] == 30
    assert captured_request["max_tokens"] == 8
    assert captured_request["disable_thinking"] is True


def test_ai_model_returns_provider_failure_as_test_result(tmp_path: Path, monkeypatch):
    def reject_model(*_args, **_kwargs):
        raise LlmCompletionError("模型请求失败：密钥 secret 无法识别 LiteLLM 供应商")

    timestamps = iter([20.0, 20.024])
    monkeypatch.setattr(api, "complete_text", reject_model)
    monkeypatch.setattr(api, "perf_counter", lambda: next(timestamps))

    with create_client(tmp_path) as client:
        response = client.post("/api/ai/models/test", json=MODEL_REQUEST)

    assert response.status_code == 200
    assert response.json() == {
        "available": False,
        "latency_ms": 24,
        "message": "模型请求失败：密钥 [已隐藏] 无法识别 LiteLLM 供应商",
    }


def test_preferences_patch_preserves_typed_ai_models(tmp_path: Path):
    with create_client(tmp_path) as client:
        updated = client.patch(
            "/api/preferences",
            json={"ai_models": [MODEL_REQUEST]},
        )
        listed = client.get("/api/ai/models")

    assert updated.status_code == 200
    assert listed.status_code == 200
    assert listed.json() == [
        {
            "model_id": MODEL_ID,
            "name": "测试模型",
            "litellm_model": "openai/test-model",
            "input_modalities": ["text"],
            "tool_calling_mode": "auto",
        }
    ]


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
