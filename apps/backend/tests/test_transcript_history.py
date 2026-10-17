from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from openvideo.core.identifiers import is_prefixed_uuid7, uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import MediaAsset, MediaAssetStatus, SourcePlatform
from openvideo.core.transcription_models import Transcript, TranscriptSegment
from openvideo.preferences import PreferenceStore
from openvideo.settings import Settings
from openvideo.ui.api import create_app


def test_manual_edits_and_regeneration_can_be_restored_after_restart(tmp_path: Path):
    library_path = tmp_path / "library"
    library_path.mkdir()
    preferences = PreferenceStore(tmp_path / "preferences.json")
    app = create_app(Settings(), preferences)
    asset_id = str(uuid7())
    base_url = f"/api/media/assets/{asset_id}/transcript"
    with TestClient(app) as client:
        client.post("/api/library/activate", json={"path": str(library_path)})
        library = app.state.library
        library.save(
            MediaAsset(
                asset_id=asset_id,
                source_url="local://video.mp4",
                source_platform=SourcePlatform.LOCAL,
                status=MediaAssetStatus.READY,
            )
        )
        original = Transcript(
            asset_id=asset_id,
            language="zh",
            segments=[
                TranscriptSegment(start_seconds=1, end_seconds=3, text="识别原文")
            ],
        )
        library.save_transcript(original)
        assert client.get(f"{base_url}/versions").json() == []
        assert (
            client.patch(
                f"{base_url}/segments/0", json={"text": "人工修正"}
            ).status_code
            == 200
        )
        regenerated = original.model_copy(
            update={
                "segments": [
                    original.segments[0].model_copy(update={"text": "重新生成"})
                ]
            }
        )
        library.save_transcript(regenerated)
        versions = client.get(f"{base_url}/versions").json()
        assert len(versions) == 2
        assert {version["reason"] for version in versions} == {"edit", "replacement"}
        manual_version = versions[0]["version_id"]
        assert is_prefixed_uuid7(manual_version, "transcript-version-")
        assert (
            client.get(f"{base_url}/versions/{manual_version}").json()["segments"][0][
                "text"
            ]
            == "人工修正"
        )
        job = app.state.analysis_manager.create_initialization(asset_id)
        assert (
            client.post(f"{base_url}/versions/{manual_version}/restore").status_code
            == 409
        )
        app.state.analysis_manager.cancel(job.job_id)
        result = client.post(f"{base_url}/versions/{manual_version}/restore")
        assert result.status_code == 200
        assert result.json()["segments"][0] == {
            **original.segments[0].model_dump(),
            "text": "人工修正",
        }
        history = client.get(f"{base_url}/versions").json()
        assert history[0]["reason"] == "restore"
        undo_restore = history[0]["version_id"]
        assert (
            client.get(f"{base_url}/versions/{undo_restore}").json()["segments"][0][
                "text"
            ]
            == "重新生成"
        )
        assert (
            client.post(f"{base_url}/versions/not-a-version/restore").status_code == 404
        )

    with TestClient(
        create_app(Settings(library_path=library_path), preferences)
    ) as client:
        assert client.get(base_url).json()["segments"][0]["text"] == "人工修正"
        assert len(client.get(f"{base_url}/versions").json()) == 3
        assert (
            client.post(f"{base_url}/versions/{undo_restore}/restore").json()[
                "segments"
            ][0]["text"]
            == "重新生成"
        )


def test_failed_backup_never_overwrites_current_transcript(tmp_path: Path, monkeypatch):
    from openvideo.core import library_analysis_storage

    library = MediaLibrary.initialize_directory(tmp_path)
    asset_id = str(uuid7())
    library.save(
        MediaAsset(
            asset_id=asset_id,
            source_url="local://video.mp4",
            source_platform=SourcePlatform.LOCAL,
        )
    )
    original = Transcript(
        asset_id=asset_id,
        segments=[
            TranscriptSegment(start_seconds=0, end_seconds=1, text="珍贵的人工文字")
        ],
    )
    library.save_transcript(original)
    write_model = library_analysis_storage.atomic_write_model

    def fail_history(path, model):
        if isinstance(model, library_analysis_storage.TranscriptVersion):
            raise OSError("disk full")
        write_model(path, model)

    monkeypatch.setattr(library_analysis_storage, "atomic_write_model", fail_history)
    with pytest.raises(OSError, match="disk full"):
        library.save_transcript(original.model_copy(update={"segments": []}))
    assert library.load_transcript(asset_id) == original
    with pytest.raises(ValueError):
        library.load_transcript_version(asset_id, "../../outside")
    library.close()
