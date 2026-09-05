from pathlib import Path
import hashlib
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
import torch

from openvideo import agent_retrieval_models
from openvideo.agent_retrieval_models import (
    EMBEDDING_BATCH_SIZE,
    NeuralRetrievalModels,
    RetrievalModelSpec,
    _last_token_pool,
)
from openvideo.configuration import OPENVIDEO_CONFIG_DIRECTORY


def test_retrieval_models_default_to_user_configuration_directory():
    models = NeuralRetrievalModels()

    assert (
        models.root_directory
        == (OPENVIDEO_CONFIG_DIRECTORY / "retrieval-models").resolve()
    )


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
    assert downloads == [(spec.repository, spec.modelscope_revision, str(first))]
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


def test_document_encoding_deduplicates_and_groups_lengths_without_reordering_results(
    tmp_path: Path,
    monkeypatch,
):
    models = NeuralRetrievalModels(tmp_path)
    unique_texts = [
        text
        for length in range(1, EMBEDDING_BATCH_SIZE + 1)
        for text in ("短" * length, "长" * (100 + length))
    ]
    texts = [*unique_texts, unique_texts[0], unique_texts[-1], unique_texts[0]]
    batches = []
    progress = []
    preparation = []

    def encode(batch, *, is_query):
        assert not is_query
        batches.append(list(batch))
        return [[float(len(text))] * models.dimensions for text in batch]

    monkeypatch.setattr(
        models, "prepare_embedding", lambda report: preparation.append("embedding")
    )
    monkeypatch.setattr(
        models, "prepare_reranker", lambda report: preparation.append("reranker")
    )
    monkeypatch.setattr(models, "_encode", encode)

    vectors = models.encode_documents(
        texts,
        lambda stage, done, total: progress.append((stage, done, total)),
    )

    assert vectors == [[float(len(text))] * models.dimensions for text in texts]
    assert [text for batch in batches for text in batch] == sorted(
        unique_texts, key=len
    )
    assert len(batches) == 2
    assert preparation == ["embedding", "reranker"]
    assert progress == [
        ("embedding_documents", EMBEDDING_BATCH_SIZE + 2, len(texts)),
        ("embedding_documents", len(texts), len(texts)),
    ]
    padded_characters = sum(max(map(len, batch)) * len(batch) for batch in batches)
    original_batches = [
        unique_texts[start : start + EMBEDDING_BATCH_SIZE]
        for start in range(0, len(unique_texts), EMBEDDING_BATCH_SIZE)
    ]
    original_padding = sum(
        max(map(len, batch)) * len(batch) for batch in original_batches
    )
    assert padded_characters < original_padding


def test_empty_document_encoding_does_not_load_models(tmp_path: Path, monkeypatch):
    models = NeuralRetrievalModels(tmp_path)
    prepare_embedding = Mock()
    prepare_reranker = Mock()
    report_progress = Mock()
    monkeypatch.setattr(models, "prepare_embedding", prepare_embedding)
    monkeypatch.setattr(models, "prepare_reranker", prepare_reranker)

    assert models.encode_documents([], report_progress) == []

    prepare_embedding.assert_not_called()
    prepare_reranker.assert_not_called()
    report_progress.assert_not_called()


def test_document_encoding_releases_model_lock_between_batches(
    tmp_path: Path, monkeypatch
):
    models = NeuralRetrievalModels(tmp_path)
    first_batch_complete = Event()
    query_complete = Event()
    monkeypatch.setattr(models, "prepare_embedding", lambda report: None)
    monkeypatch.setattr(models, "prepare_reranker", lambda report: None)
    monkeypatch.setattr(
        models,
        "_encode",
        lambda texts, is_query: [
            [float(len(text))] * models.dimensions for text in texts
        ],
    )

    def report_progress(stage, done, total):
        if done < total:
            first_batch_complete.set()
            assert query_complete.wait(timeout=5)

    texts = ["证据" * length for length in range(1, EMBEDDING_BATCH_SIZE + 2)]
    with ThreadPoolExecutor(max_workers=2) as executor:
        encoding = executor.submit(models.encode_documents, texts, report_progress)
        try:
            assert first_batch_complete.wait(timeout=5)
            query = executor.submit(
                models.encode_query,
                "前台问题",
                models.model_name,
                models.model_version,
                models.dimensions,
            )
            assert (
                query.result(timeout=5) == [float(len("前台问题"))] * models.dimensions
            )
        finally:
            query_complete.set()
        assert len(encoding.result(timeout=5)) == len(texts)


@pytest.fixture
def tiny_qwen3_configuration():
    from transformers import Qwen3Config

    return Qwen3Config(
        vocab_size=32,
        hidden_size=16,
        intermediate_size=32,
        num_hidden_layers=1,
        num_attention_heads=2,
        num_key_value_heads=1,
        head_dim=8,
        max_position_embeddings=64,
        use_cache=True,
    )


def test_embedding_without_generation_cache_preserves_vectors(
    tmp_path: Path,
    tiny_qwen3_configuration,
):
    from transformers import Qwen3Model

    with torch.random.fork_rng(devices=[]):
        torch.manual_seed(7)
        model = Qwen3Model(tiny_qwen3_configuration).eval()
    inputs = {
        "input_ids": torch.tensor([[0, 1, 4], [1, 4, 5]]),
        "attention_mask": torch.tensor([[0, 1, 1], [1, 1, 1]]),
    }
    models = NeuralRetrievalModels(tmp_path)
    models._embedding_model = model
    models._embedding_tokenizer = Mock(return_value=inputs)
    models._device = torch.device("cpu")
    models.dimensions = tiny_qwen3_configuration.hidden_size
    with torch.inference_mode():
        baseline = model(**inputs, use_cache=True)
        expected = torch.nn.functional.normalize(
            baseline.last_hidden_state[:, -1].float(), p=2, dim=1
        )
    assert baseline.past_key_values is not None

    with patch.object(model, "forward", wraps=model.forward) as forward:
        actual = models._encode(["短文", "较长文本"], is_query=False)

    assert forward.call_args.kwargs["use_cache"] is False
    torch.testing.assert_close(torch.tensor(actual), expected)


def test_reranking_last_token_without_generation_cache_preserves_scores(
    tmp_path: Path,
    tiny_qwen3_configuration,
):
    from transformers import Qwen3ForCausalLM

    with torch.random.fork_rng(devices=[]):
        torch.manual_seed(11)
        model = Qwen3ForCausalLM(tiny_qwen3_configuration).eval()
    inputs = {
        "input_ids": torch.tensor([[0, 1, 4, 1], [1, 4, 5, 1]]),
        "attention_mask": torch.tensor([[0, 1, 1, 1], [1, 1, 1, 1]]),
    }
    tokenizer = Mock()
    tokenizer.encode.return_value = [1]
    tokenizer.pad.return_value = inputs
    tokenizer.side_effect = lambda text, **kwargs: (
        SimpleNamespace(input_ids=[2 if text == "yes" else 3])
        if isinstance(text, str)
        else {"input_ids": [[4], [4, 5]]}
    )
    models = NeuralRetrievalModels(tmp_path)
    models._reranker_model = model
    models._reranker_tokenizer = tokenizer
    models._device = torch.device("cpu")
    with torch.inference_mode():
        baseline = model(**inputs, use_cache=True)
        last_logits = baseline.logits[:, -1]
        binary_logits = torch.stack([last_logits[:, 3], last_logits[:, 2]], dim=1)
        expected = torch.nn.functional.softmax(binary_logits.float(), dim=1)[:, 1]
    assert baseline.logits.shape[1] == inputs["input_ids"].shape[1]
    assert baseline.past_key_values is not None

    with patch.object(model, "forward", wraps=model.forward) as forward:
        actual = models._rerank_batch("查询", ["短文", "较长文本"])

    assert forward.call_args.kwargs["use_cache"] is False
    assert forward.call_args.kwargs["logits_to_keep"] == 1
    torch.testing.assert_close(torch.tensor(actual), expected)
