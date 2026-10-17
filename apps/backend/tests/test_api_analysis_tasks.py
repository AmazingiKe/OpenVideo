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

    with TestClient(
        create_app(Settings(library_path=library_path), preferences)
    ) as client:
        response = client.get("/api/analysis")
        snapshots = {item["job"]["job_id"]: item for item in response.json()}
        assert snapshots[second.job_id]["job"]["stage"] == "cancelled"
        assert (
            snapshots[second.job_id]["transcription_options"]
            == second_options.model_dump()
        )
        assert client.get("/api/analysis?limit=0").status_code == 422
        assert client.get("/api/analysis?limit=201").status_code == 422


def test_old_progress_schema_is_upgraded_without_losing_jobs(tmp_path):
    from datetime import UTC, datetime
    import sqlite3

    from openvideo.core.analysis_models import AnalysisJob
    from openvideo.core.library import MediaLibrary
    from openvideo.core.library_index import DATABASE_FILE_NAME

    (tmp_path / "library").mkdir()
    library = MediaLibrary.initialize_directory(tmp_path / "library")
    asset_id = str(uuid7())
    library.save(
        MediaAsset(
            asset_id=asset_id,
            source_url="local://test.mp4",
            source_platform=SourcePlatform.LOCAL,
        )
    )
    job = AnalysisJob(job_id=f"job-{uuid7().hex}", asset_id=asset_id)
    library.save_analysis_job(job)
    library.close()
    with sqlite3.connect(tmp_path / "library" / DATABASE_FILE_NAME) as connection:
        connection.execute("ALTER TABLE analysis_jobs DROP COLUMN progress_known")
        connection.execute("ALTER TABLE analysis_jobs DROP COLUMN started_at")
    library = MediaLibrary.open(tmp_path / "library")
    restored = library.load_analysis_jobs()[0]
    assert restored.job_id == job.job_id
    assert restored.started_at is None
    assert not restored.progress_known
    restored.started_at = datetime.now(UTC)
    restored.progress_known = True
    library.save_analysis_job(restored)
    library.close()
    library = MediaLibrary.open(tmp_path / "library")
    assert library.load_analysis_jobs()[0] == restored
    library.close()
