import json
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from openvideo.core.transcription_models import TranscriptionEngine, find_transcription_model
from openvideo.preferences import PreferenceStore
from openvideo.settings import Settings
from openvideo.transcription_model_manager import (
    MODEL_MANIFEST_FILE_NAME,
    QWEN_FORCED_ALIGNER_REPOSITORY,
    SENSEVOICE_VAD_REPOSITORY,
    TranscriptionModelDownloadError,
    TranscriptionModelResource,
    _resolve_resource_files,
    download_transcription_model,
    is_transcription_model_installed,
    transcription_model_directory,
    transcription_model_resources,
)
from openvideo.ui import api


def reject_modelscope(*_args, **_kwargs):
    raise RuntimeError("ModelScope unavailable")


def create_client(tmp_path: Path) -> TestClient:
    return TestClient(
        api.create_app(
            Settings(models_directory=str(tmp_path / "models")),
            PreferenceStore(tmp_path / "config" / "preferences.json"),
        )
    )


def test_downloads_model_and_reports_installed_state(tmp_path: Path, monkeypatch):
    def download_model(descriptor, models_root_directory, progress_callback):
        progress_callback(25, 100)
        model_directory = transcription_model_directory(
            models_root_directory,
            descriptor.engine,
            descriptor.model,
        )
        model_directory.mkdir(parents=True)
        (model_directory / "model.bin").write_bytes(b"model")
        (model_directory / MODEL_MANIFEST_FILE_NAME).write_text(
            json.dumps({"repository": descriptor.repository}),
            encoding="utf-8",
        )
        progress_callback(100, 100)

    monkeypatch.setattr(
        "openvideo.transcription_model_manager.download_transcription_model",
        download_model,
    )

    with create_client(tmp_path) as client:
        created = client.post(
            "/api/transcription/models/faster-whisper/small/downloads"
        )
        job_id = created.json()["job_id"]
        completed = None
        for _ in range(50):
            completed = client.get(
                f"/api/transcription/model-downloads/{job_id}"
            ).json()
            if completed["stage"] == "complete":
                break
            time.sleep(0.01)
        models = client.get("/api/transcription/models").json()

    assert created.status_code == 202
    assert job_id.startswith("model-download-")
    assert completed is not None
    assert completed["progress_percent"] == 100
    state = next(model for model in models if model["model"] == "small")
    assert state["installation_status"] == "installed"


def test_model_download_rejects_unknown_model(tmp_path: Path):
    with create_client(tmp_path) as client:
        response = client.post(
            "/api/transcription/models/faster-whisper/not-a-model/downloads"
        )

    assert response.status_code == 409
    assert response.json()["detail"] == "转录模型不存在"


def _write_manifest(directory: Path, repository: str) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / MODEL_MANIFEST_FILE_NAME).write_text(
        json.dumps({"repository": repository}),
        encoding="utf-8",
    )


def test_qwen_installation_requires_shared_forced_aligner(tmp_path: Path):
    descriptor = find_transcription_model(
        TranscriptionEngine.QWEN3_ASR,
        "qwen3-asr-1.7b",
    )
    assert descriptor is not None
    resources = transcription_model_resources(descriptor, tmp_path)
    _write_manifest(resources[0].directory, resources[0].repository)

    assert is_transcription_model_installed(descriptor, tmp_path) is False

    _write_manifest(resources[1].directory, resources[1].repository)

    assert resources[1].repository == QWEN_FORCED_ALIGNER_REPOSITORY
    assert is_transcription_model_installed(descriptor, tmp_path) is True


def test_sensevoice_download_only_fetches_missing_vad(
    tmp_path: Path,
    monkeypatch,
):
    descriptor = find_transcription_model(
        TranscriptionEngine.SENSEVOICE,
        "sensevoice-small",
    )
    assert descriptor is not None
    resources = transcription_model_resources(descriptor, tmp_path)
    _write_manifest(resources[0].directory, resources[0].repository)
    resolved_repositories: list[str] = []
    downloaded_repositories: list[str] = []

    def resolve(resource):
        repository = resource.repository
        resolved_repositories.append(repository)
        return [
            SimpleNamespace(
                file_size=100,
                filename="model.bin",
                revision="revision",
            )
        ]

    def download(repository: str, *_args, **_kwargs):
        downloaded_repositories.append(repository)

    monkeypatch.setattr(
        "openvideo.transcription_model_manager._download_modelscope_resources",
        reject_modelscope,
    )
    monkeypatch.setattr(
        "openvideo.transcription_model_manager._resolve_resource_files",
        resolve,
    )
    monkeypatch.setattr(
        "openvideo.transcription_model_manager.hf_hub_download",
        download,
    )
    progress: list[tuple[int, int]] = []

    download_transcription_model(
        descriptor,
        tmp_path,
        lambda downloaded, total: progress.append((downloaded, total)),
    )

    assert resolved_repositories == [SENSEVOICE_VAD_REPOSITORY]
    assert downloaded_repositories == [SENSEVOICE_VAD_REPOSITORY]
    assert progress[-1] == (100, 100)
    assert is_transcription_model_installed(descriptor, tmp_path) is True


def test_qwen_models_share_one_forced_aligner_directory(tmp_path: Path):
    small = find_transcription_model(
        TranscriptionEngine.QWEN3_ASR,
        "qwen3-asr-0.6b",
    )
    large = find_transcription_model(
        TranscriptionEngine.QWEN3_ASR,
        "qwen3-asr-1.7b",
    )
    assert small is not None and large is not None

    small_aligner = transcription_model_resources(small, tmp_path)[1]
    large_aligner = transcription_model_resources(large, tmp_path)[1]

    assert small_aligner.directory == large_aligner.directory


def test_resolves_repository_file_metadata_with_locked_huggingface_api(
    tmp_path: Path,
    monkeypatch,
):
    class FakeApi:
        def model_info(self, repository: str, files_metadata: bool):
            assert repository == SENSEVOICE_VAD_REPOSITORY
            assert files_metadata is True
            return SimpleNamespace(
                sha="revision",
                siblings=[SimpleNamespace(rfilename="model.pt", size=100)],
            )

    monkeypatch.setattr(
        "openvideo.transcription_model_manager.HfApi",
        FakeApi,
    )

    files = _resolve_resource_files(
        TranscriptionModelResource(
            repository=SENSEVOICE_VAD_REPOSITORY,
            directory=tmp_path / "fsmn-vad",
        )
    )

    assert files[0].filename == "model.pt"
    assert files[0].file_size == 100
    assert files[0].revision == "revision"


def test_download_progress_combines_main_and_companion_resources(
    tmp_path: Path,
    monkeypatch,
):
    descriptor = find_transcription_model(
        TranscriptionEngine.QWEN3_ASR,
        "qwen3-asr-0.6b",
    )
    assert descriptor is not None

    def resolve(resource):
        repository = resource.repository
        file_size = 100 if repository == descriptor.repository else 200
        return [
            SimpleNamespace(
                file_size=file_size,
                filename="model.bin",
                revision="revision",
            )
        ]

    monkeypatch.setattr(
        "openvideo.transcription_model_manager._download_modelscope_resources",
        reject_modelscope,
    )
    monkeypatch.setattr(
        "openvideo.transcription_model_manager._resolve_resource_files",
        resolve,
    )
    monkeypatch.setattr(
        "openvideo.transcription_model_manager.hf_hub_download",
        lambda *_args, **_kwargs: None,
    )
    progress: list[tuple[int, int]] = []

    download_transcription_model(
        descriptor,
        tmp_path,
        lambda downloaded, total: progress.append((downloaded, total)),
    )

    assert progress[0] == (0, 300)
    assert progress[-1] == (300, 300)


def test_failed_companion_download_resumes_without_refetching_main_manifest(
    tmp_path: Path,
    monkeypatch,
):
    descriptor = find_transcription_model(
        TranscriptionEngine.QWEN3_ASR,
        "qwen3-asr-0.6b",
    )
    assert descriptor is not None
    resources = transcription_model_resources(descriptor, tmp_path)
    resolved_repositories: list[str] = []
    fail_companion = True

    def resolve(resource):
        repository = resource.repository
        resolved_repositories.append(repository)
        return [
            SimpleNamespace(
                file_size=100,
                filename="model.bin",
                revision="revision",
            )
        ]

    def download(repository: str, *_args, **_kwargs):
        if repository == QWEN_FORCED_ALIGNER_REPOSITORY and fail_companion:
            raise RuntimeError("连接中断")

    monkeypatch.setattr(
        "openvideo.transcription_model_manager._download_modelscope_resources",
        reject_modelscope,
    )
    monkeypatch.setattr(
        "openvideo.transcription_model_manager._resolve_resource_files",
        resolve,
    )
    monkeypatch.setattr(
        "openvideo.transcription_model_manager.hf_hub_download",
        download,
    )

    with pytest.raises(TranscriptionModelDownloadError, match="连接中断"):
        download_transcription_model(descriptor, tmp_path, lambda *_: None)

    assert (resources[0].directory / MODEL_MANIFEST_FILE_NAME).is_file()
    assert not (resources[1].directory / MODEL_MANIFEST_FILE_NAME).is_file()

    fail_companion = False
    resolved_repositories.clear()
    download_transcription_model(descriptor, tmp_path, lambda *_: None)

    assert resolved_repositories == [QWEN_FORCED_ALIGNER_REPOSITORY]
    assert is_transcription_model_installed(descriptor, tmp_path) is True


def test_modelscope_is_the_primary_official_model_source(
    tmp_path: Path,
    monkeypatch,
):
    descriptor = find_transcription_model(
        TranscriptionEngine.FASTER_WHISPER,
        "small",
    )
    assert descriptor is not None
    downloads = []

    monkeypatch.setattr(
        "openvideo.transcription_model_manager._resolve_modelscope_resource_files",
        lambda resource: [
            SimpleNamespace(
                file_size=5,
                filename="model.bin",
                revision="master",
            )
        ],
    )

    def download(*, model_id, revision, local_dir):
        downloads.append((model_id, revision, local_dir))
        (Path(local_dir) / "model.bin").write_bytes(b"model")

    monkeypatch.setattr(
        "openvideo.transcription_model_manager._modelscope_snapshot_download",
        download,
    )
    monkeypatch.setattr(
        "openvideo.transcription_model_manager._download_huggingface_resources",
        lambda *args: pytest.fail("ModelScope 成功时不应访问备用源"),
    )
    progress = []

    download_transcription_model(
        descriptor,
        tmp_path,
        lambda downloaded, total: progress.append((downloaded, total)),
    )

    model_directory = transcription_model_directory(
        tmp_path,
        descriptor.engine,
        descriptor.model,
    )
    assert downloads == [(descriptor.repository, "master", str(model_directory))]
    assert progress == [(0, 5), (5, 5)]
    assert is_transcription_model_installed(descriptor, tmp_path) is True
