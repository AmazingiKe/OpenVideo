from pathlib import Path

from fastapi.testclient import TestClient

from openvideo.preferences import PreferenceStore
from openvideo.settings import PROJECT_ROOT, Settings
from openvideo.ui.api import create_app
from openvideo.ui.directory_picker import DirectoryPickerError


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


def test_rejects_library_inside_application_directory(tmp_path: Path):
    app = create_app(Settings(), PreferenceStore(tmp_path / "preferences.json"))

    with TestClient(app) as client:
        response = client.post(
            "/api/library/create",
            json={"path": str(PROJECT_ROOT / "library")},
        )

    assert response.status_code == 422
    assert response.json()["code"] == "library_path_inside_application"


def test_select_directory_returns_absolute_path(tmp_path: Path):
    app = create_app(
        Settings(),
        PreferenceStore(tmp_path / "preferences.json"),
        directory_picker=lambda: str(tmp_path),
    )

    with TestClient(app) as client:
        response = client.post("/api/directories/select", json={})

    assert response.status_code == 200
    assert response.json() == {"path": str(tmp_path)}


def test_cancel_directory_selection_returns_null(tmp_path: Path):
    app = create_app(
        Settings(),
        PreferenceStore(tmp_path / "preferences.json"),
        directory_picker=lambda: None,
    )

    with TestClient(app) as client:
        response = client.post("/api/directories/select", json={})

    assert response.status_code == 200
    assert response.json() == {"path": None}


def test_unavailable_directory_picker_returns_stable_error(tmp_path: Path):
    def unavailable_picker() -> str | None:
        raise DirectoryPickerError("无法打开系统文件夹选择器")

    app = create_app(
        Settings(),
        PreferenceStore(tmp_path / "preferences.json"),
        directory_picker=unavailable_picker,
    )

    with TestClient(app) as client:
        response = client.post("/api/directories/select", json={})

    assert response.status_code == 503
    assert response.json() == {
        "code": "directory_picker_unavailable",
        "message": "无法打开系统文件夹选择器",
    }


def test_folder_api_manages_nested_virtual_folders(tmp_path: Path):
    library_path = tmp_path / "portable"
    library_path.mkdir()
    app = create_app(Settings(), PreferenceStore(tmp_path / "preferences.json"))

    with TestClient(app) as client:
        assert client.post(
            "/api/library/create", json={"path": str(library_path)}
        ).status_code == 201
        root = client.post(
            "/api/library/folders", json={"name": "课程", "parent_id": None}
        ).json()
        child = client.post(
            "/api/library/folders",
            json={"name": "镜头", "parent_id": root["folder_id"]},
        ).json()

        duplicate = client.post(
            "/api/library/folders", json={"name": "课程", "parent_id": None}
        )
        cycle = client.put(
            f"/api/library/folders/{root['folder_id']}/parent",
            json={"parent_id": child["folder_id"]},
        )
        unconfirmed = client.request(
            "DELETE",
            f"/api/library/folders/{root['folder_id']}",
            json={"confirmation_name": None},
        )
        confirmed = client.request(
            "DELETE",
            f"/api/library/folders/{root['folder_id']}",
            json={"confirmation_name": "课程"},
        )

        assert duplicate.status_code == 409
        assert cycle.status_code == 409
        assert unconfirmed.status_code == 409
        assert confirmed.status_code == 204
        assert client.get("/api/library/folders").json() == []
