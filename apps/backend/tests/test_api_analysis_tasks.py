from pathlib import Path

from fastapi.testclient import TestClient

from openvideo.core.identifiers import uuid7
from openvideo.core.media_models import MediaAsset, MediaAssetStatus, SourcePlatform
from openvideo.core.transcription_models import TranscriptionOptions
from openvideo.preferences import PreferenceStore
from openvideo.settings import Settings
from openvideo.ui.api import create_app


def test_task_history_keeps_all_active_jobs_when_history_limit_is_small(tmp_path: Path):
    library_path = tmp_path / "library"
    library_path.mkdir()
    app = create_app(Settings(), PreferenceStore(tmp_path / "preferences.json"))
    with TestClient(app) as client:
        client.post("/api/library/activate", json={"path": str(library_path)})
        manager = app.state.analysis_manager
        library = app.state.library
        asset_ids = [str(uuid7()) for _ in range(2)]
        for asset_id in asset_ids:
            library.save(
                MediaAsset(
                    asset_id=asset_id,
                    source_url="local://video.mp4",
                    source_platform=SourcePlatform.LOCAL,
                    status=MediaAssetStatus.READY,
                )
            )
        active = manager.create_initialization(asset_ids[0])
        history_ids = []
        for _ in range(3):
            history = manager.create_initialization(asset_ids[1])
            manager.cancel(history.job_id)
            history_ids.append(history.job_id)
        response = client.get("/api/analysis?limit=1")
        assert response.status_code == 200
        jobs = {item["job"]["job_id"]: item["job"] for item in response.json()}
        assert set(jobs) == {active.job_id, history_ids[-1]}
        assert jobs[active.job_id]["stage"] == "pending"
        assert jobs[history_ids[-1]]["stage"] == "cancelled"
        snapshot = manager.list_jobs(1)
        snapshot[0].message = "外部修改"
        assert manager.get(snapshot[0].job_id).message != "外部修改"
        manager.cancel(active.job_id)


def test_restored_transcription_only_uses_options_owned_by_that_job(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setattr(
        "openvideo.analysis_manager.require_transcription_model_installed",
        lambda *_: None,
    )
    library_path = tmp_path / "library"
    library_path.mkdir()
    settings = Settings()
    preferences = PreferenceStore(tmp_path / "preferences.json")
    app = create_app(settings, preferences)
    with TestClient(app) as client:
        client.post("/api/library/activate", json={"path": str(library_path)})
        asset_id = str(uuid7())
        app.state.library.save(
            MediaAsset(
                asset_id=asset_id,
                source_url="local://video.mp4",
                source_platform=SourcePlatform.LOCAL,
                status=MediaAssetStatus.READY,
            )
        )
        manager = app.state.analysis_manager
        first = manager.create_transcription(
            asset_id, TranscriptionOptions(language="zh"), force=True
        )
        manager.cancel(first.job_id)
        second_options = TranscriptionOptions(language="en", model="base")
        second = manager.create_transcription(asset_id, second_options, force=True)
        response = client.get("/api/analysis")
        snapshots = {item["job"]["job_id"]: item for item in response.json()}
        assert snapshots[first.job_id]["transcription_options"] is None
        assert (
            snapshots[second.job_id]["transcription_options"]
            == second_options.model_dump()
        )
        manager.cancel(second.job_id)

    with TestClient(create_app(Settings(library_path=library_path), preferences)) as client:
        response = client.get("/api/analysis")
        snapshots = {item["job"]["job_id"]: item for item in response.json()}
        assert snapshots[second.job_id]["job"]["stage"] == "cancelled"
        assert (
            snapshots[second.job_id]["transcription_options"]
            == second_options.model_dump()
        )
        assert client.get("/api/analysis?limit=0").status_code == 422
        assert client.get("/api/analysis?limit=201").status_code == 422
