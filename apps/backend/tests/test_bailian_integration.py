import json
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from threading import Event
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from keyring.backend import KeyringBackend
from keyring.errors import KeyringError

from openvideo import analysis_manager as analysis_manager_module
from openvideo.agent_retrieval_models import NeuralRetrievalModels
from openvideo.analysis_manager import AnalysisError, AnalysisManager
from openvideo.bailian_credentials import BailianCredentialStore
from openvideo.core.analysis_models import AnalysisStage
from openvideo.core.bailian_models import BailianAsrConfiguration, BailianRegion
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.library_files import TRANSCRIPTION_METADATA_FILE_NAME
from openvideo.core.media_models import MediaAsset, MediaAssetStatus, SourcePlatform
from openvideo.core.transcription_models import (
    BAILIAN_FUN_ASR_MODEL,
    BAILIAN_PARAFORMER_MODEL,
    Transcript,
    TranscriptSegment,
    TranscriptionEngine,
    TranscriptionOptions,
    TranscriptionStatus,
)
from openvideo.download_accounts import DownloadAccountStore
from openvideo.llm.capability_resolver import CapabilityResolver
from openvideo.llm.models_dev import ModelsDevCatalog
from openvideo.llm.probe_cache import ProbeCache
from openvideo.preferences import PreferenceStore
from openvideo.settings import Settings
from openvideo.tools import transcribe as transcribe_module
from openvideo.tools.bailian_asr import BailianAsrError
from openvideo.tools.transcribe import AudioExtractionResult
from openvideo.ui import api


ASSET_ID = str(uuid7())
BEIJING_SECRET = "sk-beijing-private-key"
SINGAPORE_SECRET = "sk-singapore-private-key"


class MemoryKeyringBackend(KeyringBackend):
    priority = 1

    def __init__(self) -> None:
        self.credentials: dict[tuple[str, str], str] = {}

    def get_password(self, service: str, username: str) -> str | None:
        return self.credentials.get((service, username))

    def set_password(self, service: str, username: str, password: str) -> None:
        self.credentials[(service, username)] = password

    def delete_password(self, service: str, username: str) -> None:
        del self.credentials[(service, username)]


@dataclass
class BailianApplication:
    client: TestClient
    preferences: PreferenceStore
    credentials: BailianCredentialStore
    keyring: MemoryKeyringBackend


@pytest.fixture
def bailian_application(tmp_path: Path, monkeypatch) -> Iterator[BailianApplication]:
    monkeypatch.delenv("OPENVIDEO_LIBRARY_PATH", raising=False)
    config_directory = tmp_path / "config"
    preferences = PreferenceStore(config_directory / "preferences.json")
    keyring_backend = MemoryKeyringBackend()
    credentials = BailianCredentialStore(keyring_backend)
    library_path = tmp_path / "library"
    library_path.mkdir()
    library = MediaLibrary.initialize_directory(library_path)
    library.asset_directory(ASSET_ID).mkdir(parents=True)
    (library.asset_directory(ASSET_ID) / "playback.mp4").write_bytes(b"video")
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="file:///test-video.mp4",
            source_platform=SourcePlatform.LOCAL,
            title="百炼测试视频",
            status=MediaAssetStatus.READY,
            playback_path="playback.mp4",
            duration_seconds=60,
        )
    )
    library.close()
    settings = Settings(
        library_path=library_path,
        models_directory=str(tmp_path / "models"),
    )
    resolver = CapabilityResolver(
        models_dev=ModelsDevCatalog(config_directory / "models-dev.json"),
        probe_cache=ProbeCache(config_directory / "probes.json"),
    )
    app = api.create_app(
        settings,
        preferences,
        download_account_store=DownloadAccountStore(config_directory),
        capability_resolver=resolver,
        retrieval_models=NeuralRetrievalModels(tmp_path / "retrieval-models"),
        bailian_credential_store=credentials,
    )
    with TestClient(app) as client:
        yield BailianApplication(client, preferences, credentials, keyring_backend)


def test_preferences_save_key_without_echoing_or_persisting_secret(bailian_application):
    app = bailian_application

    saved = app.client.patch(
        "/api/preferences", json={"bailian_asr": {"api_key": BEIJING_SECRET}}
    )
    loaded = app.client.get("/api/preferences")

    for response in (saved, loaded):
        assert response.status_code == 200
        assert response.json()["bailian_asr"] == {
            "region": "beijing",
            "api_key_configured": True,
        }
        assert BEIJING_SECRET not in response.text
    persisted = app.preferences.path.read_text(encoding="utf-8")
    assert json.loads(persisted)["bailian_asr"] == {"region": "beijing"}
    assert BEIJING_SECRET not in persisted
    assert not app.preferences.path.with_suffix(".tmp").exists()
    assert app.credentials.get_api_key(BailianRegion.BEIJING) == BEIJING_SECRET


@pytest.mark.parametrize(
    "patch",
    [
        {},
        {"bailian_asr": None},
        {"bailian_asr": {}},
        {"bailian_asr": {"api_key": None}},
    ],
)
def test_preferences_omitted_or_null_key_preserves_existing_credential(
    bailian_application, patch
):
    app = bailian_application
    app.credentials.set_api_key(BailianRegion.BEIJING, BEIJING_SECRET)

    response = app.client.patch("/api/preferences", json=patch)

    assert response.status_code == 200
    assert response.json()["bailian_asr"]["api_key_configured"] is True
    assert app.credentials.get_api_key(BailianRegion.BEIJING) == BEIJING_SECRET
    assert BEIJING_SECRET not in app.preferences.path.read_text(encoding="utf-8")


@pytest.mark.parametrize("empty_key", ["", " \t\n"])
def test_preferences_empty_key_removes_current_region_only(
    bailian_application, empty_key
):
    app = bailian_application
    app.credentials.set_api_key(BailianRegion.BEIJING, BEIJING_SECRET)
    app.credentials.set_api_key(BailianRegion.SINGAPORE, SINGAPORE_SECRET)

    response = app.client.patch(
        "/api/preferences", json={"bailian_asr": {"api_key": empty_key}}
    )

    assert response.status_code == 200
    assert response.json()["bailian_asr"]["api_key_configured"] is False
    assert app.credentials.get_api_key(BailianRegion.BEIJING) is None
    assert app.credentials.get_api_key(BailianRegion.SINGAPORE) == SINGAPORE_SECRET


def test_preferences_region_switch_uses_separate_credentials(bailian_application):
    app = bailian_application
    app.credentials.set_api_key(BailianRegion.BEIJING, BEIJING_SECRET)

    switched = app.client.patch(
        "/api/preferences", json={"bailian_asr": {"region": "singapore"}}
    )
    saved = app.client.patch(
        "/api/preferences", json={"bailian_asr": {"api_key": SINGAPORE_SECRET}}
    )
    restored = app.client.patch(
        "/api/preferences", json={"bailian_asr": {"region": "beijing"}}
    )

    assert switched.json()["bailian_asr"]["api_key_configured"] is False
    assert saved.json()["bailian_asr"]["api_key_configured"] is True
    assert restored.json()["bailian_asr"] == {
        "region": "beijing",
        "api_key_configured": True,
    }
    assert app.credentials.get_api_key(BailianRegion.BEIJING) == BEIJING_SECRET
    assert app.credentials.get_api_key(BailianRegion.SINGAPORE) == SINGAPORE_SECRET


def test_singapore_paraformer_patch_is_rejected_before_saving_key(bailian_application):
    app = bailian_application

    response = app.client.patch(
        "/api/preferences",
        json={
            "bailian_asr": {"region": "singapore", "api_key": SINGAPORE_SECRET},
            "default_transcription": {"engine": "bailian", "model": "paraformer-v2"},
        },
    )

    assert response.status_code == 422
    assert "Paraformer" in response.json()["detail"]
    assert app.credentials.get_api_key(BailianRegion.SINGAPORE) is None
    assert (
        app.client.get("/api/preferences").json()["bailian_asr"]["region"] == "beijing"
    )


def test_keyring_write_failure_does_not_mutate_preferences_or_echo_secret(
    bailian_application, monkeypatch
):
    app = bailian_application
    monkeypatch.setattr(
        app.keyring, "set_password", Mock(side_effect=KeyringError(BEIJING_SECRET))
    )

    response = app.client.patch(
        "/api/preferences",
        json={"bailian_asr": {"region": "singapore", "api_key": BEIJING_SECRET}},
    )

    assert response.status_code == 409
    assert "系统凭据库" in response.json()["detail"]
    assert BEIJING_SECRET not in response.text
    assert not app.preferences.path.exists()
    assert app.client.app.state.settings.bailian_asr.region == BailianRegion.BEIJING


def test_cloud_catalog_is_installed_without_local_download(bailian_application):
    client = bailian_application.client

    response = client.get("/api/transcription/models")

    assert response.status_code == 200
    cloud_models = {
        model["model"]: model
        for model in response.json()
        if model["engine"] == "bailian"
    }
    assert set(cloud_models) == {BAILIAN_PARAFORMER_MODEL, BAILIAN_FUN_ASR_MODEL}
    for model_name, model in cloud_models.items():
        assert model["installation_status"] == "installed"
        assert model["download_job"] is None
        rejected = client.post(
            f"/api/transcription/models/bailian/{model_name}/downloads"
        )
        assert rejected.status_code == 409
        assert "无需下载" in rejected.json()["detail"]
    client.patch("/api/preferences", json={"bailian_asr": {"region": "singapore"}})
    singapore_models = client.get("/api/transcription/models").json()
    assert [
        model["model"] for model in singapore_models if model["engine"] == "bailian"
    ] == [BAILIAN_FUN_ASR_MODEL]


def test_unconfigured_cloud_transcription_fails_before_job_or_upload(
    bailian_application, monkeypatch
):
    app = bailian_application
    start = Mock()
    monkeypatch.setattr(app.client.app.state.analysis_manager, "start", start)
    cloud_transcriber = Mock()
    monkeypatch.setattr(
        analysis_manager_module, "BailianTranscriber", cloud_transcriber
    )

    response = app.client.post(
        f"/api/media/assets/{ASSET_ID}/transcribe",
        json={"engine": "bailian", "model": "fun-asr"},
    )

    assert response.status_code == 409
    assert "API Key" in response.json()["detail"]
    start.assert_not_called()
    cloud_transcriber.assert_not_called()
    assert app.client.app.state.library.load_transcription_metadata(ASSET_ID) is None
    assert app.client.app.state.library.load_analysis_jobs() == []


def test_explicit_singapore_paraformer_request_is_rejected_before_start(
    bailian_application, monkeypatch
):
    app = bailian_application
    app.credentials.set_api_key(BailianRegion.SINGAPORE, SINGAPORE_SECRET)
    app.client.patch("/api/preferences", json={"bailian_asr": {"region": "singapore"}})
    start = Mock()
    monkeypatch.setattr(app.client.app.state.analysis_manager, "start", start)

    response = app.client.post(
        f"/api/media/assets/{ASSET_ID}/transcribe",
        json={"engine": "bailian", "model": "paraformer-v2"},
    )

    assert response.status_code == 409
    assert "Paraformer" in response.json()["detail"]
    start.assert_not_called()


@pytest.mark.parametrize("has_key", [False, True])
def test_connection_check_uses_mock_without_submitting_transcription(
    bailian_application, monkeypatch, has_key
):
    app = bailian_application
    if has_key:
        app.credentials.set_api_key(BailianRegion.BEIJING, BEIJING_SECRET)
    connection_test = Mock()
    monkeypatch.setattr(api, "test_bailian_connection", connection_test)

    response = app.client.post("/api/transcription/bailian/test")

    assert response.status_code == 200
    assert response.json()["configured"] is has_key
    assert BEIJING_SECRET not in response.text
    if has_key:
        connection_test.assert_called_once_with(
            BEIJING_SECRET, BailianAsrConfiguration().base_url
        )
    else:
        connection_test.assert_not_called()
    assert app.client.app.state.library.load_analysis_jobs() == []


def test_connection_check_reports_provider_failure(bailian_application, monkeypatch):
    app = bailian_application
    app.credentials.set_api_key(BailianRegion.BEIJING, BEIJING_SECRET)
    monkeypatch.setattr(
        api,
        "test_bailian_connection",
        Mock(side_effect=BailianAsrError("百炼服务暂时不可用")),
    )

    response = app.client.post("/api/transcription/bailian/test")

    assert response.status_code == 200
    assert response.json() == {"configured": False, "message": "百炼服务暂时不可用"}
    assert app.credentials.get_api_key(BailianRegion.BEIJING) == BEIJING_SECRET


def test_recovered_cloud_task_uses_saved_region_and_persists_submission_before_resume(
    bailian_application, monkeypatch
):
    app = bailian_application
    library = app.client.app.state.library
    settings = app.client.app.state.settings
    app.credentials.set_api_key(BailianRegion.BEIJING, BEIJING_SECRET)
    app.credentials.set_api_key(BailianRegion.SINGAPORE, SINGAPORE_SECRET)
    settings.bailian_asr = BailianAsrConfiguration(region=BailianRegion.SINGAPORE)
    options = TranscriptionOptions(
        engine=TranscriptionEngine.BAILIAN, model=BAILIAN_FUN_ASR_MODEL
    )
    original_job = app.client.app.state.analysis_manager.create_transcription(
        ASSET_ID, options, force=False
    )
    metadata = library.load_transcription_metadata(ASSET_ID)
    library.save_transcription_metadata(
        metadata.model_copy(update={"cloud_task_id": "existing-cloud-task"})
    )
    settings.bailian_asr = BailianAsrConfiguration(region=BailianRegion.BEIJING)
    recovered_manager = AnalysisManager(
        library, settings, bailian_credential_store=app.credentials
    )
    start = Mock()
    monkeypatch.setattr(recovered_manager, "start", start)
    recovered_manager.restore()
    cloud_transcriber = Mock()
    local_transcriber = Mock()
    monkeypatch.setattr(
        analysis_manager_module, "BailianTranscriber", cloud_transcriber
    )
    monkeypatch.setattr(
        analysis_manager_module, "create_transcriber", local_transcriber
    )

    recovered_job = recovered_manager.get(original_job.job_id)
    transcriber = recovered_manager._prepare_transcriber(
        recovered_job, options, library.get(ASSET_ID)
    )

    start.assert_called_once_with(original_job.job_id)
    assert transcriber is cloud_transcriber.return_value
    assert cloud_transcriber.call_args.args == (
        options,
        SINGAPORE_SECRET,
        BailianAsrConfiguration(region=BailianRegion.SINGAPORE).base_url,
    )
    assert cloud_transcriber.call_args.kwargs["task_id"] == "existing-cloud-task"
    assert cloud_transcriber.call_args.kwargs["duration_seconds"] == 60
    local_transcriber.assert_not_called()
    cloud_transcriber.call_args.kwargs["on_task_submitted"]("persisted-cloud-task")
    metadata_path = (
        library.artifacts_directory(ASSET_ID) / TRANSCRIPTION_METADATA_FILE_NAME
    )
    persisted = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert persisted["cloud_task_id"] == "persisted-cloud-task"
    assert persisted["cloud_region"] == "singapore"
    assert BEIJING_SECRET not in metadata_path.read_text(encoding="utf-8")
    assert SINGAPORE_SECRET not in metadata_path.read_text(encoding="utf-8")
    current_metadata = library.load_transcription_metadata(ASSET_ID)
    library.save_transcription_metadata(
        current_metadata.model_copy(update={"job_id": f"job-{uuid7().hex}"})
    )
    with pytest.raises(AnalysisError, match="状态已变更"):
        cloud_transcriber.call_args.kwargs["on_task_submitted"]("stale-cloud-task")
    assert (
        library.load_transcription_metadata(ASSET_ID).cloud_task_id
        == "persisted-cloud-task"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("terminal_task", [False, True])
async def test_cloud_retry_reuses_interrupted_task_but_not_provider_terminal_task(
    bailian_application, monkeypatch, terminal_task
):
    app = bailian_application
    library = app.client.app.state.library
    manager = app.client.app.state.analysis_manager
    app.credentials.set_api_key(BailianRegion.BEIJING, BEIJING_SECRET)
    options = TranscriptionOptions(
        engine=TranscriptionEngine.BAILIAN, model=BAILIAN_FUN_ASR_MODEL
    )
    original_job = manager.create_transcription(ASSET_ID, options, force=False)
    metadata = library.load_transcription_metadata(ASSET_ID)
    library.save_transcription_metadata(
        metadata.model_copy(update={"cloud_task_id": "existing-cloud-task"})
    )
    failed_transcription = Mock(
        side_effect=BailianAsrError(
            "供应商已终止任务" if terminal_task else "读取云端结果时连接中断",
            terminal_task=terminal_task,
        )
    )
    monkeypatch.setattr(
        analysis_manager_module, "transcribe_media", failed_transcription
    )

    await manager._run(original_job.job_id)

    failed_metadata = library.load_transcription_metadata(ASSET_ID)
    expected_task_id = None if terminal_task else "existing-cloud-task"
    assert failed_metadata.status == TranscriptionStatus.FAILED
    assert failed_metadata.cloud_task_id == expected_task_id
    assert failed_metadata.cloud_region == BailianRegion.BEIJING
    failed_transcription.assert_called_once()

    retry_job = manager.create_transcription(ASSET_ID, options, force=False)
    retry_metadata = library.load_transcription_metadata(ASSET_ID)
    cloud_transcriber = Mock()
    monkeypatch.setattr(
        analysis_manager_module, "BailianTranscriber", cloud_transcriber
    )
    manager._prepare_transcriber(retry_job, options, library.get(ASSET_ID))

    assert retry_job.job_id != original_job.job_id
    assert retry_metadata.attempt_count == 2
    assert retry_metadata.status == TranscriptionStatus.PENDING
    assert retry_metadata.cloud_task_id == expected_task_id
    assert cloud_transcriber.call_args.kwargs["task_id"] == expected_task_id


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "new_default",
    [
        TranscriptionOptions(),
        TranscriptionOptions(
            engine=TranscriptionEngine.BAILIAN, model=BAILIAN_PARAFORMER_MODEL
        ),
    ],
    ids=["changed-to-local", "changed-cloud-model"],
)
async def test_initialization_restore_uses_saved_options_after_default_changes(
    bailian_application, monkeypatch, new_default
):
    app = bailian_application
    library = app.client.app.state.library
    settings = app.client.app.state.settings
    saved_options = TranscriptionOptions(
        engine=TranscriptionEngine.BAILIAN, model=BAILIAN_FUN_ASR_MODEL
    )
    settings.default_transcription = saved_options
    app.credentials.set_api_key(BailianRegion.BEIJING, BEIJING_SECRET)
    job = app.client.app.state.analysis_manager.create_initialization(ASSET_ID)
    metadata = library.load_transcription_metadata(ASSET_ID)
    library.save_transcription_metadata(
        metadata.model_copy(
            update={
                "status": TranscriptionStatus.RUNNING,
                "cloud_task_id": "initialization-cloud-task",
                "cloud_region": BailianRegion.BEIJING,
            }
        )
    )
    settings.default_transcription = new_default
    recovered_manager = AnalysisManager(
        library, settings, bailian_credential_store=app.credentials
    )
    monkeypatch.setattr(recovered_manager, "start", Mock())
    recovered_manager.restore()
    cloud_transcriber = Mock()
    monkeypatch.setattr(
        analysis_manager_module, "BailianTranscriber", cloud_transcriber
    )

    def interrupt_cloud_query(*args, **_kwargs):
        args[-1]()
        raise BailianAsrError("查询暂时中断，等待下次恢复")

    monkeypatch.setattr(
        analysis_manager_module, "transcribe_media", interrupt_cloud_query
    )

    await recovered_manager._run(job.job_id)

    cloud_transcriber.assert_called_once()
    assert cloud_transcriber.call_args.args[0] == saved_options
    assert cloud_transcriber.call_args.kwargs["task_id"] == "initialization-cloud-task"
    persisted_metadata = library.load_transcription_metadata(ASSET_ID)
    assert persisted_metadata.options == saved_options
    assert persisted_metadata.cloud_task_id == "initialization-cloud-task"


@pytest.mark.asyncio
async def test_cloud_transcription_run_persists_result_source_and_submitted_task(
    bailian_application, monkeypatch, tmp_path
):
    app = bailian_application
    library = app.client.app.state.library
    manager = app.client.app.state.analysis_manager
    app.credentials.set_api_key(BailianRegion.BEIJING, BEIJING_SECRET)
    options = TranscriptionOptions(
        engine=TranscriptionEngine.BAILIAN, model=BAILIAN_FUN_ASR_MODEL
    )
    job = manager.create_transcription(ASSET_ID, options, force=False)
    expected_transcript = Transcript(
        asset_id=ASSET_ID,
        language="zh",
        segments=[
            TranscriptSegment(
                start_seconds=1, end_seconds=4, text="百炼返回的带时间戳字幕"
            )
        ],
    )
    audio_path = tmp_path / "audio.mp3"
    extraction = Mock(return_value=AudioExtractionResult(audio_path=audio_path))
    monkeypatch.setattr(transcribe_module, "extract_audio", extraction)
    monkeypatch.setattr(
        transcribe_module, "extract_platform_subtitles", Mock(return_value=None)
    )
    cloud_transcriber = Mock(
        engine=TranscriptionEngine.BAILIAN, output_source="bailian/fun-asr"
    )

    def prepare_cloud_transcriber(*_args, **kwargs):
        assert kwargs["task_id"] is None

        def recognize(extracted_audio_path, asset_id):
            assert extracted_audio_path == audio_path
            assert asset_id == ASSET_ID
            kwargs["on_task_submitted"]("successful-cloud-task")
            assert (
                library.load_transcription_metadata(ASSET_ID).cloud_task_id
                == "successful-cloud-task"
            )
            return expected_transcript

        cloud_transcriber.transcribe.side_effect = recognize
        return cloud_transcriber

    monkeypatch.setattr(
        analysis_manager_module, "BailianTranscriber", prepare_cloud_transcriber
    )

    await manager._run(job.job_id)

    assert manager.get(job.job_id).stage == AnalysisStage.COMPLETE
    assert library.load_transcript(ASSET_ID).segments == expected_transcript.segments
    metadata = library.load_transcription_metadata(ASSET_ID)
    assert metadata.status == TranscriptionStatus.COMPLETE
    assert metadata.output_source == "bailian/fun-asr"
    assert metadata.cloud_task_id == "successful-cloud-task"
    assert metadata.cloud_region == BailianRegion.BEIJING
    assert extraction.call_args.kwargs["compressed"] is True
    assert isinstance(extraction.call_args.kwargs["cancel_event"], Event)
    cloud_transcriber.transcribe.assert_called_once_with(audio_path, ASSET_ID)
    cloud_transcriber.close.assert_called_once()
