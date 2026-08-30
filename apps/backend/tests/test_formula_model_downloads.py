import json
import time
from pathlib import Path

from fastapi.testclient import TestClient

from openvideo.core.formula_models import (
    FORMULA_REQUIRED_FILES,
    formula_model_resources,
)
from openvideo.core.model_download_models import MODEL_MANIFEST_FILE_NAME
from openvideo.preferences import PreferenceStore
from openvideo.settings import Settings
from openvideo.ui import api


def create_client(tmp_path: Path) -> TestClient:
    return TestClient(
        api.create_app(
            Settings(models_directory=str(tmp_path / "models")),
            PreferenceStore(tmp_path / "config" / "preferences.json"),
        )
    )


def test_formula_models_download_as_one_automatic_capability(
    tmp_path: Path,
    monkeypatch,
):
    def download(models_root_directory, progress_callback):
        progress_callback(25, 100)
        for resource in formula_model_resources(models_root_directory):
            resource.directory.mkdir(parents=True, exist_ok=True)
            for filename in FORMULA_REQUIRED_FILES:
                (resource.directory / filename).write_bytes(b"model")
            (resource.directory / MODEL_MANIFEST_FILE_NAME).write_text(
                json.dumps({"repository": resource.repository}),
                encoding="utf-8",
            )
        progress_callback(100, 100)

    monkeypatch.setattr(
        "openvideo.formula_model_manager.download_formula_models",
        download,
    )

    with create_client(tmp_path) as client:
        initial = client.get("/api/formula-recognition/model")
        created = client.post("/api/formula-recognition/model/downloads")
        job_id = created.json()["job_id"]
        completed = None
        for _ in range(50):
            completed = client.get(
                f"/api/formula-recognition/model-downloads/{job_id}"
            ).json()
            if completed["stage"] == "complete":
                break
            time.sleep(0.01)
        installed = client.get("/api/formula-recognition/model")

    assert initial.status_code == 200
    assert initial.json()["installation_status"] == "not_installed"
    assert created.status_code == 202
    assert job_id.startswith("formula-model-download-")
    assert completed is not None and completed["progress_percent"] == 100
    assert installed.json()["installation_status"] == "installed"


def test_formula_installation_requires_verified_layout_and_recognition_resources(
    tmp_path: Path,
):
    models_root_directory = tmp_path / "models"
    resource = formula_model_resources(models_root_directory)[0]
    resource.directory.mkdir(parents=True)
    for filename in FORMULA_REQUIRED_FILES:
        (resource.directory / filename).write_bytes(b"model")
    (resource.directory / MODEL_MANIFEST_FILE_NAME).write_text(
        json.dumps({"repository": resource.repository}),
        encoding="utf-8",
    )

    with create_client(tmp_path) as client:
        state = client.get("/api/formula-recognition/model")

    assert state.json()["installation_status"] == "not_installed"
