import json
from pathlib import Path

from openvideo.preferences import PreferenceStore, Preferences
from openvideo.settings import (
    DEFAULT_MODELS_DIRECTORY,
    DEFAULT_TOOLS_DIRECTORY,
    PROJECT_ROOT,
    Settings,
    load_settings,
)


def test_preferences_are_written_atomically(tmp_path: Path):
    store = PreferenceStore(tmp_path / "OpenVideo" / "preferences.json")
    store.save(Preferences(current_library_path="D:\\资料库", openai_api_key="secret"))

    payload = json.loads(store.path.read_text(encoding="utf-8"))
    assert payload["current_library_path"] == "D:\\资料库"
    assert payload["openai_api_key"] == "secret"
    assert not store.path.with_suffix(".tmp").exists()


def test_environment_values_override_saved_preferences(monkeypatch, tmp_path: Path):
    store = PreferenceStore(tmp_path / "preferences.json")
    store.save(Preferences(models_directory="saved-models", openai_api_key="saved"))
    monkeypatch.setenv("OPENVIDEO_MODELS_DIRECTORY", str(tmp_path / "models"))
    monkeypatch.setenv("OPENVIDEO_OPENAI_API_KEY", "environment")

    settings = load_settings(store)

    assert settings.models_directory == str(tmp_path / "models")
    assert settings.openai_api_key == "environment"
    assert settings.managed_fields == {"models_directory", "openai_api_key"}


def test_default_runtime_directories_are_anchored_to_project_root():
    settings = Settings()

    assert settings.ffmpeg_bin_dir == DEFAULT_TOOLS_DIRECTORY / "ffmpeg" / "bin"
    assert settings.whisper_model_directory == DEFAULT_MODELS_DIRECTORY / "faster-whisper"


def test_library_has_no_project_default(tmp_path: Path):
    settings = load_settings(PreferenceStore(tmp_path / "preferences.json"))

    assert settings.library_path is None


def test_saved_project_library_path_returns_to_initial_setup(tmp_path: Path):
    store = PreferenceStore(tmp_path / "preferences.json")
    store.save(Preferences(current_library_path=str(PROJECT_ROOT / "library")))

    assert load_settings(store).library_path is None
