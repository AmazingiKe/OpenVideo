from pathlib import Path

from fastapi.testclient import TestClient

from openvideo.core.library import MediaLibrary
from openvideo.preferences import PreferenceStore
from openvideo.settings import Settings
from openvideo.ui.api import create_app


def initialize_library(path: Path) -> None:
    path.mkdir()
    library = MediaLibrary.initialize_directory(path)
    library.close()


def test_markers_page_settings_validate_and_persist(tmp_path: Path):
    library_path = tmp_path / "library"
    initialize_library(library_path)
    app = create_app(
        Settings(library_path=library_path),
        PreferenceStore(tmp_path / "preferences.json"),
    )

    with TestClient(app) as client:
        defaults = client.get("/api/page-settings/markers")
        assert defaults.status_code == 200
        assert defaults.json() == {
            "left_panel_size_percent": 24.0,
            "agent_panel_size_percent": 34.0,
        }

        payload = {
            "left_panel_size_percent": 28,
            "agent_panel_size_percent": 38,
        }
        saved = client.put("/api/page-settings/markers", json=payload)
        assert saved.status_code == 200
        assert client.get("/api/page-settings/markers").json() == payload

        invalid_size = client.put(
            "/api/page-settings/markers",
            json={**payload, "left_panel_size_percent": 17},
        )
        invalid_agent_size = client.put(
            "/api/page-settings/markers",
            json={**payload, "agent_panel_size_percent": 49},
        )
        assert invalid_size.status_code == 422
        assert invalid_agent_size.status_code == 422
        config_path = tmp_path / (
            f"page-settings-{app.state.library.manifest.library_id}.json"
        )
        assert config_path.is_file()
        assert not (library_path / "page_setting.json").exists()


def test_markers_page_settings_are_isolated_when_switching_libraries(
    tmp_path: Path,
):
    first_path = tmp_path / "first"
    second_path = tmp_path / "second"
    initialize_library(first_path)
    initialize_library(second_path)
    app = create_app(
        Settings(library_path=first_path),
        PreferenceStore(tmp_path / "preferences.json"),
    )

    with TestClient(app) as client:
        first_settings = client.get("/api/page-settings/markers").json()
        first_settings["left_panel_size_percent"] = 30
        assert (
            client.put("/api/page-settings/markers", json=first_settings).status_code
            == 200
        )

        assert (
            client.post(
                "/api/library/activate", json={"path": str(second_path)}
            ).status_code
            == 200
        )
        second_settings = client.get("/api/page-settings/markers").json()
        assert second_settings["left_panel_size_percent"] == 24
        assert second_settings["agent_panel_size_percent"] == 34
        assert (
            client.put("/api/page-settings/markers", json=second_settings).status_code
            == 200
        )

        assert (
            client.post(
                "/api/library/activate", json={"path": str(first_path)}
            ).status_code
            == 200
        )
        restored = client.get("/api/page-settings/markers").json()
        assert restored["left_panel_size_percent"] == 30
        assert restored["agent_panel_size_percent"] == 34


def test_markers_page_settings_require_an_open_library(tmp_path: Path):
    app = create_app(Settings(), PreferenceStore(tmp_path / "preferences.json"))

    with TestClient(app) as client:
        response = client.get("/api/page-settings/markers")

    assert response.status_code == 409
    assert response.json()["code"] == "library_not_open"
