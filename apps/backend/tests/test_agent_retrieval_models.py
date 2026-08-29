from pathlib import Path
import hashlib

import torch

from openvideo import agent_retrieval_models
from openvideo.agent_retrieval_models import (
    NeuralRetrievalModels,
    RetrievalModelSpec,
    _last_token_pool,
)
from openvideo.configuration import OPENVIDEO_CONFIG_DIRECTORY


def test_retrieval_models_default_to_user_configuration_directory():
    models = NeuralRetrievalModels()

    assert models.root_directory == (
        OPENVIDEO_CONFIG_DIRECTORY / "retrieval-models"
    ).resolve()


def test_model_download_is_revision_locked_and_manifest_guarded(
    tmp_path: Path,
    monkeypatch,
):
    downloads = []

    weights = b"verified-test-weights"
    spec = RetrievalModelSpec(
        repository="test/retrieval",
        revision="huggingface-revision",
        modelscope_revision="modelscope-revision",
        weight_sha256=hashlib.sha256(weights).hexdigest(),
        directory_name="test-retrieval",
        download_stage="downloading_embedding_model",
    )

    def download(*, model_id, revision, local_dir):
        downloads.append((model_id, revision, local_dir))
        (Path(local_dir) / "config.json").write_text("{}", encoding="utf-8")
        (Path(local_dir) / "model.safetensors").write_bytes(weights)

    monkeypatch.setattr(
        agent_retrieval_models,
        "_modelscope_snapshot_download",
        download,
    )
    models = NeuralRetrievalModels(tmp_path)
    stages = []

    first = models._ensure_installed(
        spec,
        lambda stage, processed, total: stages.append((stage, processed, total)),
    )
    second = models._ensure_installed(
        spec,
        lambda stage, processed, total: stages.append((stage, processed, total)),
    )

    assert first == second
    assert first.is_relative_to(tmp_path)
    assert downloads == [
        (spec.repository, spec.modelscope_revision, str(first))
    ]
    assert stages == [("downloading_embedding_model", 0, 0)]
    assert (first / ".openvideo-model.json").is_file()


def test_model_download_falls_back_to_locked_huggingface_revision(
    tmp_path: Path,
    monkeypatch,
):
    weights = b"fallback-weights"
    spec = RetrievalModelSpec(
        repository="test/fallback",
        revision="locked-revision",
        modelscope_revision="master",
        weight_sha256=hashlib.sha256(weights).hexdigest(),
        directory_name="fallback",
        download_stage="downloading_embedding_model",
    )
    downloads = []

    def unavailable_modelscope(**kwargs):
        raise OSError("ModelScope unavailable")

    def download(*, repo_id, revision, local_dir):
        downloads.append((repo_id, revision, local_dir))
        (Path(local_dir) / "config.json").write_text("{}", encoding="utf-8")
        (Path(local_dir) / "model.safetensors").write_bytes(weights)

    monkeypatch.setattr(
        agent_retrieval_models,
        "_modelscope_snapshot_download",
        unavailable_modelscope,
    )
    monkeypatch.setattr(
        agent_retrieval_models,
        "huggingface_snapshot_download",
        download,
    )

    directory = NeuralRetrievalModels(tmp_path)._ensure_installed(
        spec,
        lambda stage, processed, total: None,
    )

    assert downloads == [(spec.repository, spec.revision, directory)]


def test_last_token_pool_handles_left_and_right_padding():
    states = torch.tensor(
        [
            [[1.0], [2.0], [3.0]],
            [[4.0], [5.0], [6.0]],
        ]
    )
    left_padding = torch.tensor([[0, 1, 1], [1, 1, 1]])
    right_padding = torch.tensor([[1, 1, 0], [1, 1, 1]])

    assert _last_token_pool(states, left_padding).tolist() == [[3.0], [6.0]]
    assert _last_token_pool(states, right_padding).tolist() == [[2.0], [6.0]]


def test_document_index_prepares_reranker_before_reporting_ready(
    tmp_path: Path,
    monkeypatch,
):
    models = NeuralRetrievalModels(tmp_path)
    calls = []
    monkeypatch.setattr(
        models,
        "prepare_embedding",
        lambda report_progress: calls.append("embedding"),
    )
    monkeypatch.setattr(
        models,
        "_encode",
        lambda texts, is_query: [[1.0] * models.dimensions for _ in texts],
    )
    monkeypatch.setattr(
        models,
        "prepare_reranker",
        lambda report_progress: calls.append("reranker"),
    )

    vectors = models.encode_documents(["证据文本"], lambda stage, done, total: None)

    assert len(vectors) == 1
    assert calls == ["embedding", "reranker"]
