import json
from pathlib import Path

from openvideo.preferences import PreferenceStore, Preferences
from openvideo.settings import load_settings


def test_preferences_are_written_atomically(tmp_path: Path):
    store = PreferenceStore(tmp_path / "OpenVideo" / "preferences.json")
    store.save(Preferences(current_library_path="D:\\资料库", openai_api_key="secret"))

    payload = json.loads(store.path.read_text(encoding="utf-8"))
    assert payload["current_library_path"] == "D:\\资料库"
    assert payload["openai_api_key"] == "secret"
    assert not store.path.with_suffix(".tmp").exists()


def test_environment_values_override_saved_preferences(monkeypatch, tmp_path: Path):
    store = PreferenceStore(tmp_path / "preferences.json")
    store.save(Preferences(whisper_model="small", openai_api_key="saved"))
    monkeypatch.setenv("OPENVIDEO_WHISPER_MODEL", "medium")
    monkeypatch.setenv("OPENVIDEO_OPENAI_API_KEY", "environment")

    settings = load_settings(store)

    assert settings.whisper_model == "medium"
    assert settings.openai_api_key == "environment"
    assert settings.managed_fields == {"whisper_model", "openai_api_key"}
