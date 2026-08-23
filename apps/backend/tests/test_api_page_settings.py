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


def test_analysis_page_settings_validate_and_persist(tmp_path: Path):
    library_path = tmp_path / "library"
    initialize_library(library_path)
    app = create_app(
        Settings(library_path=library_path),
        PreferenceStore(tmp_path / "preferences.json"),
    )

    with TestClient(app) as client:
        defaults = client.get("/api/page-settings/analysis")
        assert defaults.status_code == 200
        assert defaults.json() == {
            "asset_library_size_percent": 14.0,
            "asset_library_collapsed": False,
            "tool_panel_size_percent": 16.0,
            "tool_panel_collapsed": False,
            "open_tool_sections": ["video_information"],
        }

        payload = {
            "asset_library_size_percent": 18,
            "asset_library_collapsed": True,
            "tool_panel_size_percent": 26,
            "tool_panel_collapsed": False,
            "open_tool_sections": ["transcription", "analysis"],
        }
        saved = client.put("/api/page-settings/analysis", json=payload)
        assert saved.status_code == 200
        assert client.get("/api/page-settings/analysis").json() == payload

        invalid_size = client.put(
            "/api/page-settings/analysis",
            json={**payload, "asset_library_size_percent": 9},
        )
        invalid_section = client.put(
            "/api/page-settings/analysis",
            json={**payload, "open_tool_sections": ["unknown"]},
        )
        duplicate_section = client.put(
            "/api/page-settings/analysis",
            json={
                **payload,
                "open_tool_sections": ["analysis", "analysis"],
            },
        )
        assert invalid_size.status_code == 422
        assert invalid_section.status_code == 422
        assert duplicate_section.status_code == 422
        config_path = tmp_path / (
            f"page-settings-{app.state.library.manifest.library_id}.json"
        )
        assert config_path.is_file()
        assert not (library_path / "page_setting.json").exists()


def test_analysis_page_settings_are_isolated_when_switching_libraries(
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
        first_settings = client.get("/api/page-settings/analysis").json()
        first_settings["asset_library_collapsed"] = True
        assert client.put(
            "/api/page-settings/analysis", json=first_settings
        ).status_code == 200

        assert client.post(
            "/api/library/open", json={"path": str(second_path)}
        ).status_code == 200
        second_settings = client.get("/api/page-settings/analysis").json()
        assert second_settings["asset_library_collapsed"] is False
        second_settings["tool_panel_size_percent"] = 28
        assert client.put(
            "/api/page-settings/analysis", json=second_settings
        ).status_code == 200

        assert client.post(
            "/api/library/open", json={"path": str(first_path)}
        ).status_code == 200
        restored = client.get("/api/page-settings/analysis").json()
        assert restored["asset_library_collapsed"] is True
        assert restored["tool_panel_size_percent"] == 16


def test_analysis_page_settings_require_an_open_library(tmp_path: Path):
    app = create_app(Settings(), PreferenceStore(tmp_path / "preferences.json"))

    with TestClient(app) as client:
        response = client.get("/api/page-settings/analysis")

    assert response.status_code == 409
    assert response.json()["code"] == "library_not_open"
