import json
import time
from pathlib import Path

from fastapi.testclient import TestClient

from openvideo.preferences import PreferenceStore
from openvideo.settings import Settings
from openvideo.transcription_model_manager import (
    MODEL_MANIFEST_FILE_NAME,
    transcription_model_directory,
)
from openvideo.ui import api


def create_client(tmp_path: Path) -> TestClient:
    return TestClient(
        api.create_app(
            Settings(models_directory=str(tmp_path / "models")),
            PreferenceStore(tmp_path / "config" / "preferences.json"),
        )
    )


def test_downloads_model_and_reports_installed_state(tmp_path: Path, monkeypatch):
    def download_model(descriptor, models_root_directory, progress_callback):
        progress_callback(25, 100)
        model_directory = transcription_model_directory(
            models_root_directory,
            descriptor.engine,
            descriptor.model,
        )
        model_directory.mkdir(parents=True)
        (model_directory / "model.bin").write_bytes(b"model")
        (model_directory / MODEL_MANIFEST_FILE_NAME).write_text(
            json.dumps({"repository": descriptor.repository}),
            encoding="utf-8",
        )
        progress_callback(100, 100)

    monkeypatch.setattr(
        "openvideo.transcription_model_manager.download_transcription_model",
        download_model,
    )

    with create_client(tmp_path) as client:
        created = client.post(
            "/api/transcription/models/faster-whisper/small/downloads"
        )
        job_id = created.json()["job_id"]
        completed = None
        for _ in range(50):
            completed = client.get(
                f"/api/transcription/model-downloads/{job_id}"
            ).json()
            if completed["stage"] == "complete":
                break
            time.sleep(0.01)
        models = client.get("/api/transcription/models").json()

    assert created.status_code == 202
    assert job_id.startswith("model-download-")
    assert completed is not None
    assert completed["progress_percent"] == 100
    state = next(model for model in models if model["model"] == "small")
    assert state["installation_status"] == "installed"


def test_model_download_rejects_unknown_model(tmp_path: Path):
    with create_client(tmp_path) as client:
        response = client.post(
            "/api/transcription/models/faster-whisper/not-a-model/downloads"
        )

    assert response.status_code == 409
    assert response.json()["detail"] == "转录模型不存在"
