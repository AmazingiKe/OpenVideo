from pathlib import Path

from fastapi.testclient import TestClient

from openvideo.core.identifiers import uuid7
from openvideo.core.media_models import MediaAsset, MediaAssetStatus, SourcePlatform
from openvideo.core.transcription_models import (
    TranscriptionEngine,
    TranscriptionMetadata,
    TranscriptionOptions,
    TranscriptionStatus,
)
from openvideo.core.bailian_models import BailianRegion
from openvideo.preferences import PreferenceStore
from openvideo.settings import Settings
from openvideo.ui.api import create_app


def test_unknown_submission_can_resume_existing_provider_task_without_resubmitting(
    tmp_path: Path, monkeypatch
):
    library_path = tmp_path / "library"
    library_path.mkdir()
    app = create_app(Settings(), PreferenceStore(tmp_path / "preferences.json"))
    with TestClient(app) as client:
        client.post("/api/library/activate", json={"path": str(library_path)})
        asset_id = str(uuid7())
        job_id = f"job-{uuid7().hex}"
        library = app.state.library
        library.save(
            MediaAsset(
                asset_id=asset_id,
                source_url="local://video.mp4",
                source_platform=SourcePlatform.LOCAL,
                status=MediaAssetStatus.READY,
            )
        )
        options = TranscriptionOptions(
            engine=TranscriptionEngine.BAILIAN, model="paraformer-v2"
        )
        library.save_transcription_metadata(
            TranscriptionMetadata(
                job_id=job_id,
                asset_id=asset_id,
                status=TranscriptionStatus.CANCELLED,
                engine=TranscriptionEngine.BAILIAN,
                options=options,
                cloud_region=BailianRegion.BEIJING,
                cloud_submission_uncertain=True,
            )
        )
        endpoint = f"/api/media/assets/{asset_id}/transcription-submission"
        assert client.get(endpoint).json()["uncertain"] is True
        assert client.post(endpoint, json={"job_id": job_id}).status_code == 422
        assert (
            client.post(
                endpoint,
                json={"job_id": job_id, "cloud_task_id": "../unsafe-task"},
            ).status_code
            == 422
        )
        assert (
            client.post(
                endpoint,
                json={"job_id": f"job-{uuid7().hex}", "cloud_task_id": "known-task"},
            ).status_code
            == 409
        )
        app.state.settings.bailian_asr.region = BailianRegion.SINGAPORE
        assert (
            client.post(
                endpoint, json={"job_id": job_id, "cloud_task_id": "known-task"}
            ).status_code
            == 409
        )
        app.state.settings.bailian_asr.region = BailianRegion.BEIJING
        response = client.post(
            endpoint, json={"job_id": job_id, "cloud_task_id": "known-task"}
        )
        assert response.status_code == 200
        assert response.json()["uncertain"] is False
        assert response.json()["cloud_task_id"] == "known-task"
        assert library.load_analysis_jobs() == []
        assert (
            client.post(
                endpoint,
                json={"job_id": job_id, "confirm_not_submitted": True},
            ).status_code
            == 409
        )

        manager = app.state.analysis_manager
        monkeypatch.setattr(manager, "_require_bailian_credentials", lambda *_: "key")
        job = manager.create_transcription(asset_id, options, force=True)
        saved = library.load_transcription_metadata(asset_id)
        assert saved.cloud_task_id == "known-task"
        assert saved.options == options
        assert not manager._tasks
        manager.cancel(job.job_id)


def test_confirming_no_provider_task_unlocks_local_transcription_after_stop(
    tmp_path: Path, monkeypatch
):
    library_path = tmp_path / "library"
    library_path.mkdir()
    app = create_app(Settings(), PreferenceStore(tmp_path / "preferences.json"))
    with TestClient(app) as client:
        client.post("/api/library/activate", json={"path": str(library_path)})
        library = app.state.library
        manager = app.state.analysis_manager
        asset_id = str(uuid7())
        library.save(
            MediaAsset(
                asset_id=asset_id,
                source_url="local://video.mp4",
                source_platform=SourcePlatform.LOCAL,
                status=MediaAssetStatus.READY,
            )
        )
        job = manager.create_initialization(asset_id)
        library.save_transcription_metadata(
            TranscriptionMetadata(
                job_id=job.job_id,
                asset_id=asset_id,
                status=TranscriptionStatus.RUNNING,
                engine=TranscriptionEngine.BAILIAN,
                options=TranscriptionOptions(
                    engine=TranscriptionEngine.BAILIAN, model="paraformer-v2"
                ),
                cloud_submission_uncertain=True,
            )
        )
        endpoint = f"/api/media/assets/{asset_id}/transcription-submission"
        resolution = {"job_id": job.job_id, "confirm_not_submitted": True}
        assert client.post(endpoint, json=resolution).status_code == 409
        manager.cancel(job.job_id)
        ambiguous = {**resolution, "cloud_task_id": "known-task"}
        assert client.post(endpoint, json=ambiguous).status_code == 422
        assert client.post(endpoint, json=resolution).status_code == 200
        assert client.get(endpoint).json()["uncertain"] is False
        monkeypatch.setattr(
            "openvideo.analysis_manager.require_transcription_model_installed",
            lambda *_: None,
        )
        local = manager.create_transcription(
            asset_id, TranscriptionOptions(), force=True
        )
        assert local.stage.value == "pending"
        manager.cancel(local.job_id)
