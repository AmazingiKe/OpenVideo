import json
from pathlib import Path

import pytest
from pydantic import ValidationError
from platformdirs import user_config_path

from openvideo.configuration import (
    OPENVIDEO_CONFIG_DIRECTORY,
    migrate_configuration_file,
)
from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.analysis_models import TranscriptionEngine, TranscriptionOptions
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
    monkeypatch.setenv("OPENVIDEO_AI_MODELS", f"[{MODEL.model_dump_json()}]")

    settings = load_settings(store)

    assert settings.models_directory == str(tmp_path / "models")
    assert settings.ai_models == [MODEL]
    assert settings.managed_fields == {"models_directory", "ai_models"}


def test_default_runtime_directories_are_anchored_to_project_root():
    settings = Settings()

    assert settings.ffmpeg_bin_dir == DEFAULT_TOOLS_DIRECTORY / "ffmpeg" / "bin"
    assert settings.models_root_directory == DEFAULT_MODELS_DIRECTORY
    assert settings.transcription_model_directory(
        TranscriptionEngine.FASTER_WHISPER
    ) == DEFAULT_MODELS_DIRECTORY / "faster-whisper"


def test_preferences_persist_default_transcription(tmp_path: Path):
    store = PreferenceStore(tmp_path / "preferences.json")
    expected = TranscriptionOptions(model="large-v3-turbo")

    store.save(Preferences(default_transcription=expected))

    assert store.load().default_transcription == expected


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
