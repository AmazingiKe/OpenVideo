from pathlib import Path

from fastapi.testclient import TestClient

from openvideo.bailian_credentials import BailianCredentialError
from openvideo.core.identifiers import uuid7
from openvideo.core.media_models import MediaAsset, MediaAssetStatus, SourcePlatform
from openvideo.core.transcription_models import TranscriptionOptions
from openvideo.preferences import PreferenceStore
from openvideo.settings import Settings
from openvideo.ui.api import create_app


def test_preflight_checks_every_asset_without_creating_or_submitting_jobs(
    tmp_path: Path, monkeypatch
):
    library_path = tmp_path / "library"
    library_path.mkdir()
    app = create_app(Settings(), PreferenceStore(tmp_path / "preferences.json"))
    with TestClient(app) as client:
        client.post("/api/library/activate", json={"path": str(library_path)})
        library = app.state.library
        manager = app.state.analysis_manager
        monkeypatch.setattr(
            "openvideo.analysis_manager.require_transcription_model_installed",
            lambda *_: None,
        )
        monkeypatch.setattr(
            "openvideo.analysis_manager.resolve_tool", lambda *_: "/usr/bin/ffmpeg"
        )
        monkeypatch.setattr(
            manager._bailian_credentials, "require_api_key", lambda *_: "test-key"
        )
        asset_ids = [str(uuid7()), str(uuid7())]
        for index, asset_id in enumerate(asset_ids):
            library.save(
                MediaAsset(
                    asset_id=asset_id,
                    source_url="local://video.mp4",
                    source_platform=SourcePlatform.LOCAL,
                    status=MediaAssetStatus.READY,
                    title=f"视频{index}",
                    playback_path="playback.mp4",
                )
            )
        library.asset_directory(asset_ids[0]).joinpath("playback.mp4").write_bytes(
            b"video"
        )
        options = TranscriptionOptions(engine="bailian", model="fun-asr").model_dump()
        response = client.post(
            "/api/transcription/preflight",
            json={"asset_ids": asset_ids, "options": options},
        )
        assert response.status_code == 200
        assert not response.json()["ready"]
        assert any(
            "视频1：媒体文件不存在" in issue for issue in response.json()["issues"]
        )
        assert manager.list_jobs(50) == []
        assert all(
            library.load_transcription_metadata(asset_id) is None
            for asset_id in asset_ids
        )
        library.asset_directory(asset_ids[1]).joinpath("playback.mp4").write_bytes(
            b"video"
        )
        assert client.post(
            "/api/transcription/preflight",
            json={"asset_ids": asset_ids, "options": options},
        ).json()["ready"]

        def missing_key(*_):
            raise BailianCredentialError("请先保存密钥")

        monkeypatch.setattr(
            manager._bailian_credentials, "require_api_key", missing_key
        )
        monkeypatch.setattr("openvideo.analysis_manager.resolve_tool", lambda *_: None)
        result = client.post(
            "/api/transcription/preflight",
            json={"asset_ids": asset_ids, "options": options},
        ).json()
        assert not result["ready"]
        assert "请先保存密钥" in result["issues"]
        assert any("ffmpeg" in issue for issue in result["issues"])
        assert manager.list_jobs(50) == []
