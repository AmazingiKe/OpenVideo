import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from io import BytesIO
from pathlib import Path
from threading import Event
from time import sleep

from fastapi.testclient import TestClient
import httpx
import pytest

from openvideo.core.library import MediaLibrary
from openvideo.local_media_import import (
    LocalMediaImportCancelled,
    LocalMediaImportManager,
    import_video_directory,
    persist_local_media,
)
from openvideo.preferences import PreferenceStore
from openvideo.settings import Settings
from openvideo.tools.media import MediaProbe
from openvideo.ui.api import create_app
from openvideo.ui.library_routes import _run_connected_import


def test_stopping_copy_removes_unpublished_asset(tmp_path: Path):
    cancel_event = Event()

    class CancelledSource(BytesIO):
        def read(self, size=-1):
            chunk = super().read(size)
            cancel_event.set()
            return chunk

    library = MediaLibrary.initialize_directory(tmp_path)
    try:
        with pytest.raises(LocalMediaImportCancelled):
            persist_local_media(
                library,
                Settings(),
                CancelledSource(b"unfinished"),
                "video.mp4",
                cancel_event=cancel_event,
            )
        assert library.list() == []
        assert list(library.assets_path.iterdir()) == []
    finally:
        library.close()


def test_stop_after_probe_does_not_publish_asset(tmp_path: Path, monkeypatch):
    cancel_event = Event()

    def stopped_probe(*args, **kwargs):
        cancel_event.set()
        return MediaProbe(1, 16, 16, "h264", None)

    monkeypatch.setattr("openvideo.local_media_import.probe_media", stopped_probe)
    monkeypatch.setattr("openvideo.local_media_import.resolve_tool", lambda *_: None)
    library = MediaLibrary.initialize_directory(tmp_path)
    try:
        with pytest.raises(LocalMediaImportCancelled):
            persist_local_media(
                library,
                Settings(),
                BytesIO(b"video"),
                "video.mp4",
                cancel_event=cancel_event,
            )
        assert library.list() == []
        assert list(library.assets_path.iterdir()) == []
    finally:
        library.close()


def test_directory_stop_keeps_completed_files_and_skips_remaining(
    tmp_path: Path, monkeypatch
):
    library_path = tmp_path / "library"
    source_path = tmp_path / "source"
    library_path.mkdir()
    source_path.mkdir()
    (source_path / "first.mp4").write_bytes(b"first")
    (source_path / "second.mp4").write_bytes(b"second")
    cancel_event = Event()

    def finish_first(*args, **kwargs):
        asset = persist_local_media(*args, **kwargs)
        cancel_event.set()
        return asset

    monkeypatch.setattr(
        "openvideo.local_media_import.persist_local_media", finish_first
    )
    monkeypatch.setattr(
        "openvideo.local_media_import.probe_media",
        lambda *_, **__: MediaProbe(1, 16, 16, "h264", None),
    )
    monkeypatch.setattr("openvideo.local_media_import.resolve_tool", lambda *_: None)
    library = MediaLibrary.initialize_directory(library_path)
    try:
        with pytest.raises(LocalMediaImportCancelled):
            import_video_directory(
                library,
                Settings(),
                source_path,
                include_subfolders=False,
                cancel_event=cancel_event,
            )
        assert [asset.title for asset in library.list()] == ["first"]
    finally:
        library.close()


@pytest.mark.asyncio
async def test_request_cancellation_waits_for_worker_before_closing_source():
    manager = LocalMediaImportManager()
    cancel_event = Event()
    started = Event()
    finished = Event()
    source = BytesIO(b"still open")

    def operation():
        started.set()
        assert cancel_event.wait(timeout=2)
        assert not source.closed
        finished.set()
        raise LocalMediaImportCancelled("已停止")

    async def request():
        try:
            await manager.run(operation, cancel_event)
        finally:
            source.close()

    task = asyncio.create_task(request())
    try:
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=2)
        assert finished.is_set()
        assert source.closed
        assert not manager.has_active_imports()
    finally:
        cancel_event.set()
        await manager.close()


@pytest.mark.asyncio
async def test_disconnected_client_cancels_server_side_import():
    manager = LocalMediaImportManager()
    cancel_event = Event()
    started = Event()

    class DisconnectedRequest:
        async def is_disconnected(self):
            return started.is_set()

    def operation():
        started.set()
        assert cancel_event.wait(timeout=2)
        raise LocalMediaImportCancelled("已停止")

    try:
        with pytest.raises(LocalMediaImportCancelled):
            await asyncio.wait_for(
                _run_connected_import(
                    DisconnectedRequest(), manager, operation, cancel_event
                ),
                timeout=3,
            )
        assert not manager.has_active_imports()
    finally:
        await manager.close()


def test_import_keeps_other_requests_responsive_and_prevents_library_switch(
    tmp_path: Path, monkeypatch
):
    from openvideo import local_media_import

    original_copy = local_media_import._copy_file
    started = Event()
    release = Event()

    def blocked_copy(*args):
        started.set()
        assert release.wait(timeout=5)
        return original_copy(*args)

    monkeypatch.setattr(local_media_import, "_copy_file", blocked_copy)
    monkeypatch.setattr(
        local_media_import,
        "probe_media",
        lambda *_, **__: MediaProbe(1, 16, 16, "h264", None),
    )
    monkeypatch.setattr(local_media_import, "resolve_tool", lambda *_: None)
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    app = create_app(Settings(), PreferenceStore(tmp_path / "preferences.json"))
    with TestClient(app) as client, ThreadPoolExecutor(max_workers=1) as executor:
        library_id = client.post(
            "/api/library/activate", json={"path": str(first)}
        ).json()["library_id"]
        importing = executor.submit(
            partial(
                client.post,
                "/api/media/assets/import",
                data={"library_id": library_id},
                files={"file": ("video.mp4", b"video", "video/mp4")},
            )
        )
        try:
            assert started.wait(timeout=2)
            assert not importing.done()
            assert client.get("/api/media/assets").status_code == 200
            closing = client.delete("/api/library")
            switching = client.post("/api/library/activate", json={"path": str(second)})
            assert closing.status_code == switching.status_code == 409
            assert closing.json()["code"] == "library_has_active_tasks"
            assert client.get("/api/library").json()["library_id"] == library_id
        finally:
            release.set()
        assert importing.result(timeout=3).status_code == 201
        assert client.delete("/api/library").status_code == 204


def test_stale_import_cannot_write_into_another_library(tmp_path: Path):
    library_path = tmp_path / "library"
    library_path.mkdir()
    app = create_app(Settings(), PreferenceStore(tmp_path / "preferences.json"))
    with TestClient(app) as client:
        client.post("/api/library/activate", json={"path": str(library_path)})
        response = client.post(
            "/api/media/assets/import",
            data={"library_id": "library-from-old-window"},
            files={"file": ("video.mp4", b"video", "video/mp4")},
        )
        directory_response = client.post(
            "/api/media/assets/import-directory",
            json={"library_id": "library-from-old-window", "path": str(tmp_path)},
        )
        assert response.status_code == directory_response.status_code == 409
        assert client.get("/api/media/assets").json() == []
        assert list(app.state.library.assets_path.iterdir()) == []


@pytest.mark.asyncio
async def test_cancelled_upload_request_finishes_cleanup_before_file_close(
    tmp_path: Path, monkeypatch
):
    started = Event()
    finished = Event()
    closed_early: list[bool] = []

    def copying(source, destination, cancel_event):
        started.set()
        assert cancel_event.wait(timeout=3)
        sleep(0.1)
        closed_early.append(source.closed)
        finished.set()
        raise LocalMediaImportCancelled("已停止")

    monkeypatch.setattr("openvideo.local_media_import._copy_file", copying)
    library_path = tmp_path / "library"
    library_path.mkdir()
    app = create_app(Settings(), PreferenceStore(tmp_path / "preferences.json"))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            library_id = (
                await client.post(
                    "/api/library/activate", json={"path": str(library_path)}
                )
            ).json()["library_id"]
            task = asyncio.create_task(
                client.post(
                    "/api/media/assets/import",
                    data={"library_id": library_id},
                    files={"file": ("video.mp4", b"video", "video/mp4")},
                )
            )
            assert await asyncio.to_thread(started.wait, 2)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(task, timeout=2)
            async with asyncio.timeout(2):
                while app.state.local_media_import_manager.has_active_imports():
                    await asyncio.sleep(0.01)
            assert closed_early == [False]
            assert finished.is_set()
            assert not app.state.local_media_import_manager.has_active_imports()
            assert app.state.library.list() == []
            assert list(app.state.library.assets_path.iterdir()) == []
