import json
from pathlib import Path

import pytest
from pydantic import ValidationError
from platformdirs import user_config_path

from openvideo.configuration import (
    OPENVIDEO_CONFIG_DIRECTORY,
    migrate_configuration_file,
)
from openvideo.core.agent_governance_models import (
    AgentPermissionGrant,
    AgentPermissionGrantScope,
    AgentPermissionMode,
    AgentPreferences,
    AgentResourceScope,
    AgentThinkingMode,
)
from openvideo.core.ai_models import (
    AiModelConfiguration,
    online_api_configuration_error,
)
from openvideo.core.identifiers import uuid7
from openvideo.core.transcription_models import TranscriptionEngine, TranscriptionOptions
from openvideo.preferences import PreferenceStore, Preferences
from openvideo.settings import (
    DEFAULT_MODELS_DIRECTORY,
    DEFAULT_TOOLS_DIRECTORY,
    PROJECT_ROOT,
    Settings,
    load_settings,
)


MODEL = AiModelConfiguration(
    model_id="model-01890f4c7a2b7cc298c4dc0c0c07398f",
    name="主模型",
    litellm_model="openai/gpt-5.6-terra",
    api_key="secret",
)


def test_preferences_are_written_atomically(tmp_path: Path):
    store = PreferenceStore(tmp_path / "OpenVideo" / "preferences.json")
    store.save(Preferences(current_library_path="D:\\资料库", ai_models=[MODEL]))

    payload = json.loads(store.path.read_text(encoding="utf-8"))
    assert payload["current_library_path"] == "D:\\资料库"
    assert payload["ai_models"][0]["api_key"] == "secret"
    assert not store.path.with_suffix(".tmp").exists()


def test_configuration_directory_has_one_application_segment():
    assert OPENVIDEO_CONFIG_DIRECTORY == user_config_path(
        "OpenVideo", appauthor=False
    )


def test_legacy_configuration_is_moved_to_central_directory(tmp_path: Path):
    source_path = tmp_path / "OpenVideo" / "OpenVideo" / "preferences.json"
    target_path = tmp_path / "OpenVideo" / "preferences.json"
    source_path.parent.mkdir(parents=True)
    source_path.write_text('{"current_library_path": null}', encoding="utf-8")

    migrate_configuration_file(source_path, target_path)

    assert target_path.read_text(encoding="utf-8") == (
        '{"current_library_path": null}'
    )
    assert not source_path.exists()


def test_environment_values_override_saved_preferences(monkeypatch, tmp_path: Path):
    store = PreferenceStore(tmp_path / "preferences.json")
    store.save(Preferences(models_directory="saved-models"))
    monkeypatch.setenv("OPENVIDEO_MODELS_DIRECTORY", str(tmp_path / "models"))
    monkeypatch.setenv("OPENVIDEO_DOWNLOAD_PROXY", "socks5://127.0.0.1:7890")
    monkeypatch.setenv("OPENVIDEO_AI_MODELS", f"[{MODEL.model_dump_json()}]")

    settings = load_settings(store)

    assert settings.models_directory == str(tmp_path / "models")
    assert settings.download_proxy == "socks5://127.0.0.1:7890"
    assert settings.ai_models == [MODEL]
    assert settings.managed_fields == {
        "models_directory",
        "download_proxy",
        "ai_models",
    }


def test_download_proxy_is_normalized_and_validated():
    assert Preferences(download_proxy="  http://127.0.0.1:7890  ").download_proxy == (
        "http://127.0.0.1:7890"
    )

    with pytest.raises(ValidationError, match="HTTP、HTTPS 或 SOCKS"):
        Preferences(download_proxy="127.0.0.1:7890")


def test_default_tools_and_models_use_runtime():
    settings = Settings()

    assert settings.ffmpeg_bin_dir == DEFAULT_TOOLS_DIRECTORY / "ffmpeg" / "bin"
    assert DEFAULT_MODELS_DIRECTORY == PROJECT_ROOT / "runtime" / "models"
    assert settings.models_root_directory == DEFAULT_MODELS_DIRECTORY
    assert settings.transcription_model_directory(
        TranscriptionEngine.FASTER_WHISPER
    ) == DEFAULT_MODELS_DIRECTORY / "faster-whisper"


def test_preferences_persist_default_transcription(tmp_path: Path):
    store = PreferenceStore(tmp_path / "preferences.json")
    expected = TranscriptionOptions(model="large-v3-turbo")

    store.save(Preferences(default_transcription=expected))

    assert store.load().default_transcription == expected


def test_preferences_persist_agent_roles_permissions_and_limits(tmp_path: Path):
    store = PreferenceStore(tmp_path / "preferences.json")
    model_id = f"model-{uuid7().hex}"
    grant = AgentPermissionGrant(
        capability="summary.edit",
        resource_scope=AgentResourceScope.CURRENT_ITEM,
        scope=AgentPermissionGrantScope.ALWAYS,
    )
    expected = AgentPreferences(
        permission_mode=AgentPermissionMode.FULL_ACCESS,
        fast_model_id=model_id,
        complex_model_id=model_id,
        vision_model_id=model_id,
        default_thinking_mode=AgentThinkingMode.COMPLEX,
        max_concurrent_runs=8,
        always_allowed_grants=[grant],
    )

    store.save(Preferences(agent=expected))

    assert store.load().agent == expected


def test_library_has_no_project_default(tmp_path: Path):
    settings = load_settings(PreferenceStore(tmp_path / "preferences.json"))

    assert settings.library_path is None


def test_saved_project_library_path_returns_to_initial_setup(tmp_path: Path):
    store = PreferenceStore(tmp_path / "preferences.json")
    store.save(Preferences(current_library_path=str(PROJECT_ROOT / "library")))

    assert load_settings(store).library_path is None


def test_model_configuration_rejects_duplicate_persisted_identifiers():
    with pytest.raises(ValidationError, match="AI 模型标识不能重复"):
        Preferences(ai_models=[MODEL, MODEL])


def test_model_configuration_migrates_legacy_vision_capability():
    migrated_model = AiModelConfiguration.model_validate(
        {
            "model_id": "model-01890f4c7a2b7cc298c4dc0c0c07398f",
            "name": "旧视觉模型",
            "litellm_model": "openai/vision-model",
            "supports_vision": True,
        }
    )

    assert migrated_model.input_modalities == ["text", "image"]
    assert "supports_vision" not in migrated_model.model_dump()


@pytest.mark.parametrize(
    ("model_name", "api_base", "expected_route"),
    [
        (
            "deepseek-v4-flash-vision-exp",
            None,
            "deepseek/deepseek-v4-flash-vision-exp",
        ),
        ("claude-sonnet-4-5", None, "anthropic/claude-sonnet-4-5"),
        ("custom-model", "https://api.openai.com/v1", "openai/custom-model"),
        ("custom-model", "https://models.example.com/v1", "custom-model"),
        (
            "deepseek/deepseek-v4-flash-vision-exp",
            None,
            "deepseek/deepseek-v4-flash-vision-exp",
        ),
        (
            "anthropic/claude-sonnet-4-5",
            "https://openrouter.ai/api/v1",
            "openrouter/anthropic/claude-sonnet-4-5",
        ),
    ],
)
def test_model_configuration_resolves_internal_provider_route(
    model_name: str,
    api_base: str | None,
    expected_route: str,
):
    configured_model = AiModelConfiguration(
        name="测试模型",
        litellm_model=model_name,
        api_base=api_base,
    )

    assert configured_model.litellm_model == expected_route


def test_model_configuration_requires_text_and_unique_modalities():
    with pytest.raises(ValidationError, match="要求支持文本输入"):
        AiModelConfiguration.model_validate(
            {
                **MODEL.model_dump(),
                "input_modalities": ["image"],
            }
        )

    with pytest.raises(ValidationError, match="输入模态不能重复"):
        AiModelConfiguration.model_validate(
            {
                **MODEL.model_dump(),
                "input_modalities": ["text", "text"],
            }
        )


@pytest.mark.parametrize(
    ("litellm_model", "api_base", "message"),
    [
        ("ollama/qwen2.5-vl", None, "本地推理供应商"),
        ("openai/custom", "http://models.example.com/v1", "HTTPS"),
        ("openai/custom", "https://127.0.0.1:1234/v1", "本机或局域网地址"),
        ("openai/custom", "https://192.168.1.20:1234/v1", "本机或局域网地址"),
    ],
)
def test_local_llm_configuration_remains_loadable_but_cannot_run(
    litellm_model: str,
    api_base: str | None,
    message: str,
):
    local_model = MODEL.model_copy(
        update={"litellm_model": litellm_model, "api_base": api_base}
    )
    settings = Settings(ai_models=[local_model])

    assert message in (online_api_configuration_error(local_model) or "")
    assert settings.online_ai_models == []
    assert settings.ai_model(local_model.model_id) is None


def test_hosted_llm_configuration_is_available_to_runtime():
    hosted_model = MODEL.model_copy(
        update={"api_base": "https://models.example.com/v1"}
    )
    settings = Settings(ai_models=[hosted_model])

    assert online_api_configuration_error(hosted_model) is None
    assert settings.online_ai_models == [hosted_model]
    assert settings.ai_model(hosted_model.model_id) == hosted_model
