from io import BytesIO
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from openvideo.preferences import PreferenceStore
from openvideo.settings import PROJECT_ROOT, Settings
from openvideo.tools.media import MediaProbe
from openvideo.ui.api import create_app
from openvideo.ui.directory_picker import DirectoryPickerError


def test_library_gate_activate_close_and_reactivate(tmp_path: Path):
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
            "/api/library/activate",
            json={"path": str(library_path)},
        )
        assert created.status_code == 200
        assert created.json()["root_path"] == str(library_path.resolve())
        assert client.delete("/api/library").status_code == 204
        assert client.get("/api/library").json() is None

        reopened = client.post(
            "/api/library/activate", json={"path": str(library_path)}
        )
        assert reopened.status_code == 200
        assert reopened.json()["library_id"] == created.json()["library_id"]


def test_failed_switch_keeps_current_library(tmp_path: Path):
    library_path = tmp_path / "current"
    library_path.mkdir()
    app = create_app(Settings(), PreferenceStore(tmp_path / "preferences.json"))

    with TestClient(app) as client:
        created = client.post(
            "/api/library/activate",
            json={"path": str(library_path)},
        ).json()
        failed = client.post(
            "/api/library/activate", json={"path": str(tmp_path / "missing")}
        )
        assert failed.status_code == 422
        assert client.get("/api/library").json()["library_id"] == created["library_id"]


def test_activation_rejects_nonempty_directory_without_manifest(tmp_path: Path):
    library_path = tmp_path / "not-a-library"
    library_path.mkdir()
    existing_file = library_path / "keep.txt"
    existing_file.write_text("保留", encoding="utf-8")
    app = create_app(Settings(), PreferenceStore(tmp_path / "preferences.json"))

    with TestClient(app) as client:
        response = client.post(
            "/api/library/activate", json={"path": str(library_path)}
        )

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_library"
    assert existing_file.read_text(encoding="utf-8") == "保留"
    assert not (library_path / "library.json").exists()


def test_rejects_library_inside_application_directory(tmp_path: Path):
    app = create_app(Settings(), PreferenceStore(tmp_path / "preferences.json"))

    with TestClient(app) as client:
        response = client.post(
            "/api/library/activate",
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
        assert (
            client.post(
                "/api/library/activate", json={"path": str(library_path)}
            ).status_code
            == 200
        )
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


def test_dragged_video_is_imported_into_the_library(tmp_path: Path, monkeypatch):
    library_path = tmp_path / "portable"
    library_path.mkdir()
    preference_store = PreferenceStore(tmp_path / "config" / "preferences.json")
    monkeypatch.setattr(
        "openvideo.local_media_import.probe_media",
        lambda *_: MediaProbe(12.5, 1920, 1080, "h264", "aac"),
    )
    monkeypatch.setattr("openvideo.local_media_import.resolve_tool", lambda *_: None)
    app = create_app(Settings(), preference_store)

    with TestClient(app) as client:
        client.post("/api/library/activate", json={"path": str(library_path)})
        response = client.post(
            "/api/media/assets/import",
            files={"file": ("课程片段.mp4", b"video-content", "video/mp4")},
        )

        assert response.status_code == 201
        asset = response.json()
        assert asset["source_platform"] == "local"
        assert asset["source_url"] == "local://%E8%AF%BE%E7%A8%8B%E7%89%87%E6%AE%B5.mp4"
        assert asset["title"] == "课程片段"
        assert asset["duration_seconds"] == 12.5
        assert asset["status"] == "ready"
        assert asset["playback_url"].endswith(f"/{asset['asset_id']}/stream")
        saved_files = list(
            (library_path / "assets" / asset["asset_id"] / "media").iterdir()
        )
        assert [path.name for path in saved_files] == ["source.mp4"]
        assert saved_files[0].read_bytes() == b"video-content"
        assert client.head(asset["playback_url"]).headers["content-type"] == "video/mp4"


def test_video_directory_import_preserves_selected_folder_structure(
    tmp_path: Path, monkeypatch
):
    library_path = tmp_path / "portable"
    library_path.mkdir()
    source_directory = tmp_path / "课程"
    nested_directory = source_directory / "第一章" / "示例"
    nested_directory.mkdir(parents=True)
    (source_directory / "介绍.mp4").write_bytes(b"intro")
    (nested_directory / "镜头.mp4").write_bytes(b"shot")
    (nested_directory / "说明.txt").write_text("忽略", encoding="utf-8")
    monkeypatch.setattr(
        "openvideo.local_media_import.probe_media",
        lambda *_: MediaProbe(12.5, 1920, 1080, "h264", "aac"),
    )
    monkeypatch.setattr("openvideo.local_media_import.resolve_tool", lambda *_: None)
    app = create_app(
        Settings(), PreferenceStore(tmp_path / "config" / "preferences.json")
    )

    with TestClient(app) as client:
        client.post("/api/library/activate", json={"path": str(library_path)})
        response = client.post(
            "/api/media/assets/import-directory",
            json={"path": str(source_directory), "include_subfolders": True},
        )

        assert response.status_code == 201
        imported_assets = response.json()["assets"]
        assert {asset["title"] for asset in imported_assets} == {"介绍", "镜头"}
        assert response.json()["failed_files"] == []
        folders = client.get("/api/library/folders").json()
        folder_by_name = {folder["name"]: folder for folder in folders}
        assert folder_by_name["课程"]["parent_id"] is None
        assert (
            folder_by_name["第一章"]["parent_id"] == folder_by_name["课程"]["folder_id"]
        )
        assert (
            folder_by_name["示例"]["parent_id"] == folder_by_name["第一章"]["folder_id"]
        )
        asset_folder_ids = {
            asset["title"]: asset["folder_id"] for asset in imported_assets
        }
        assert asset_folder_ids == {
            "介绍": folder_by_name["课程"]["folder_id"],
            "镜头": folder_by_name["示例"]["folder_id"],
        }


def test_video_directory_import_does_not_scan_subfolders_by_default(
    tmp_path: Path, monkeypatch
):
    library_path = tmp_path / "portable"
    library_path.mkdir()
    source_directory = tmp_path / "素材"
    nested_directory = source_directory / "子文件夹"
    nested_directory.mkdir(parents=True)
    (source_directory / "顶层.mp4").write_bytes(b"top")
    (nested_directory / "下层.mp4").write_bytes(b"nested")
    monkeypatch.setattr(
        "openvideo.local_media_import.probe_media",
        lambda *_: MediaProbe(3.0, 1280, 720, "h264", "aac"),
    )
    monkeypatch.setattr("openvideo.local_media_import.resolve_tool", lambda *_: None)
    app = create_app(
        Settings(), PreferenceStore(tmp_path / "config" / "preferences.json")
    )

    with TestClient(app) as client:
        client.post("/api/library/activate", json={"path": str(library_path)})
        response = client.post(
            "/api/media/assets/import-directory",
            json={"path": str(source_directory)},
        )

        assert response.status_code == 201
        assert [asset["title"] for asset in response.json()["assets"]] == ["顶层"]
        folder_names = [
            folder["name"] for folder in client.get("/api/library/folders").json()
        ]
        assert folder_names == ["素材"]


def test_dragged_image_is_imported_into_the_library(tmp_path: Path):
    library_path = tmp_path / "portable"
    library_path.mkdir()
    app = create_app(
        Settings(), PreferenceStore(tmp_path / "config" / "preferences.json")
    )
    image_content = BytesIO()
    Image.new("RGB", (320, 180)).save(image_content, format="PNG")

    with TestClient(app) as client:
        client.post("/api/library/activate", json={"path": str(library_path)})
        response = client.post(
            "/api/media/assets/import",
            files={"file": ("封面.png", image_content.getvalue(), "image/png")},
        )

        assert response.status_code == 201
        asset = response.json()
        assert asset["media_type"] == "image"
        assert asset["title"] == "封面"
        assert asset["width"] == 320
        assert asset["height"] == 180
        assert asset["thumbnail_url"].endswith(f"/{asset['asset_id']}/thumbnail")
        assert client.get(asset["thumbnail_url"]).headers["content-type"] == "image/png"


def test_local_media_import_rejects_unsupported_and_empty_files(tmp_path: Path):
    library_path = tmp_path / "portable"
    library_path.mkdir()
    app = create_app(
        Settings(), PreferenceStore(tmp_path / "config" / "preferences.json")
    )

    with TestClient(app) as client:
        client.post("/api/library/activate", json={"path": str(library_path)})
        unsupported = client.post(
            "/api/media/assets/import",
            files={"file": ("说明.txt", b"not-video", "text/plain")},
        )
        empty = client.post(
            "/api/media/assets/import",
            files={"file": ("empty.mp4", b"", "video/mp4")},
        )

        assert unsupported.status_code == 422
        assert "仅支持" in unsupported.json()["detail"]
        assert empty.status_code == 422
        assert empty.json()["detail"] == "不能导入空的媒体文件"
        assert client.get("/api/media/assets").json() == []
