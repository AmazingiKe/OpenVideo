from pathlib import Path

from fastapi.testclient import TestClient

from openvideo.preferences import PreferenceStore
from openvideo.settings import Settings
from openvideo.ui.api import create_app


def test_library_gate_create_close_and_reopen(tmp_path: Path):
    library_path = tmp_path / "portable"
    library_path.mkdir()
    preference_store = PreferenceStore(tmp_path / "config" / "preferences.json")
    app = create_app(Settings(), preference_store)

    with TestClient(app) as client:
        assert client.get("/api/library").json() is None
        gated = client.get("/api/media/assets")
        assert gated.status_code == 409
        assert gated.json()["code"] == "library_not_open"

        created = client.post(
            "/api/library/create",
            json={"path": str(library_path)},
        )
        assert created.status_code == 201
        assert created.json()["root_path"] == str(library_path.resolve())
        assert client.delete("/api/library").status_code == 204
        assert client.get("/api/library").json() is None

        reopened = client.post("/api/library/open", json={"path": str(library_path)})
        assert reopened.status_code == 200
        assert reopened.json()["library_id"] == created.json()["library_id"]


def test_failed_switch_keeps_current_library(tmp_path: Path):
    library_path = tmp_path / "current"
    library_path.mkdir()
    app = create_app(Settings(), PreferenceStore(tmp_path / "preferences.json"))

    with TestClient(app) as client:
        created = client.post(
            "/api/library/create",
            json={"path": str(library_path)},
        ).json()
        failed = client.post("/api/library/open", json={"path": str(tmp_path / "missing")})
        assert failed.status_code == 422
        assert client.get("/api/library").json()["library_id"] == created["library_id"]
