"""OpenVideo 推荐神经检索模型的安装、推理与资源复用。"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
from threading import RLock

from huggingface_hub import snapshot_download as huggingface_snapshot_download

from openvideo.configuration import OPENVIDEO_CONFIG_DIRECTORY
from openvideo.core.model_download_models import MODEL_MANIFEST_FILE_NAME


RETRIEVAL_MODELS_DIRECTORY_NAME = "retrieval-models"
MODEL_WEIGHT_FILE_NAME = "model.safetensors"
EMBEDDING_MODEL_REPOSITORY = "Qwen/Qwen3-Embedding-0.6B"
EMBEDDING_MODEL_REVISION = "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3"
EMBEDDING_MODEL_WEIGHT_SHA256 = (
    "0437e45c94563b09e13cb7a64478fc406947a93cb34a7e05870fc8dcd48e23fd"
)
RERANKER_MODEL_REPOSITORY = "Qwen/Qwen3-Reranker-0.6B"
RERANKER_MODEL_REVISION = "e61197ed45024b0ed8a2d74b80b4d909f1255473"
RERANKER_MODEL_WEIGHT_SHA256 = (
    "27cd75a405b9c1b46b59abfd88aaa209e6fed2a1972cde9b70e7659537c5e65b"
)
MODELSCOPE_MODEL_REVISION = "master"
RETRIEVAL_MODEL_NAME = "OpenVideo/Qwen3-Embedding-Reranker-0.6B"
RETRIEVAL_MODEL_VERSION = (
    f"{EMBEDDING_MODEL_REVISION}.{RERANKER_MODEL_REVISION}"
)
EMBEDDING_DIMENSIONS = 512
EMBEDDING_BATCH_SIZE = 8
RERANKER_BATCH_SIZE = 4
EMBEDDING_MAX_TOKENS = 512
RERANKER_MAX_TOKENS = 1_024
RETRIEVAL_INSTRUCTION = (
    "Given a question about a video library, retrieve time-aligned passages "
    "that provide evidence for the answer"
)
RERANKER_SYSTEM_PROMPT = (
    "Judge whether the Document meets the requirements based on the Query and "
    'the Instruct provided. Note that the answer can only be "yes" or "no".'
)
RERANKER_SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"


ProgressReporter = Callable[[str, int, int], None]


@dataclass(frozen=True)
class RetrievalModelSpec:
    repository: str
    revision: str
    modelscope_revision: str
    weight_sha256: str
    directory_name: str
    download_stage: str


EMBEDDING_MODEL = RetrievalModelSpec(
    repository=EMBEDDING_MODEL_REPOSITORY,
    revision=EMBEDDING_MODEL_REVISION,
    modelscope_revision=MODELSCOPE_MODEL_REVISION,
    weight_sha256=EMBEDDING_MODEL_WEIGHT_SHA256,
    directory_name="qwen3-embedding-0.6b",
    download_stage="downloading_embedding_model",
)
RERANKER_MODEL = RetrievalModelSpec(
    repository=RERANKER_MODEL_REPOSITORY,
    revision=RERANKER_MODEL_REVISION,
    modelscope_revision=MODELSCOPE_MODEL_REVISION,
    weight_sha256=RERANKER_MODEL_WEIGHT_SHA256,
    directory_name="qwen3-reranker-0.6b",
    download_stage="downloading_reranker_model",
)


class RetrievalModelError(RuntimeError):
    """模型文件或推理结果不满足检索索引的确定性契约。"""


class NeuralRetrievalModels:
    """只提供一套经过选择的嵌入与重排模型，避免用户承担模型试错。"""

    model_name = RETRIEVAL_MODEL_NAME
    model_version = RETRIEVAL_MODEL_VERSION
    dimensions = EMBEDDING_DIMENSIONS

    def __init__(self, root_directory: Path | None = None) -> None:
        self.root_directory = (
            root_directory
            if root_directory is not None
            else OPENVIDEO_CONFIG_DIRECTORY / RETRIEVAL_MODELS_DIRECTORY_NAME
        ).resolve()
        self._embedding_tokenizer = None
        self._embedding_model = None
        self._reranker_tokenizer = None
        self._reranker_model = None
        self._device = None
        self._lock = RLock()

    def prepare_embedding(self, report_progress: ProgressReporter) -> None:
        with self._lock:
            if self._embedding_model is not None:
                return
            directory = self._ensure_installed(EMBEDDING_MODEL, report_progress)
            report_progress("loading_embedding_model", 0, 0)
            torch, auto_model, auto_tokenizer = _transformer_runtime()
            device, dtype = _inference_device(torch)
            tokenizer = auto_tokenizer.from_pretrained(
                directory,
                local_files_only=True,
                padding_side="left",
            )
            model = auto_model.from_pretrained(
                directory,
                local_files_only=True,
                dtype=dtype,
            )
            model.to(device)
            model.eval()
            self._device = device
            self._embedding_tokenizer = tokenizer
            self._embedding_model = model

    def encode_documents(
        self,
        texts: Sequence[str],
        report_progress: ProgressReporter,
    ) -> list[list[float]]:
        self.prepare_embedding(report_progress)
        vectors: list[list[float]] = []
        total = len(texts)
        with self._lock:
            for start in range(0, total, EMBEDDING_BATCH_SIZE):
                batch = texts[start : start + EMBEDDING_BATCH_SIZE]
                vectors.extend(self._encode(batch, is_query=False))
                report_progress("embedding_documents", min(start + len(batch), total), total)
        self.prepare_reranker(report_progress)
        return vectors

    def encode_query(
        self,
        query: str,
        model_name: str,
        model_version: str,
        dimensions: int,
    ) -> list[float]:
        if (
            model_name != self.model_name
            or model_version != self.model_version
            or dimensions != self.dimensions
        ):
            return []
        self.prepare_embedding(_ignore_progress)
        with self._lock:
            return self._encode([query], is_query=True)[0]

    def rerank(self, query: str, documents: Sequence[str]) -> list[float]:
        if not documents:
            return []
        self.prepare_reranker(_ignore_progress)
        scores: list[float] = []
        with self._lock:
            for start in range(0, len(documents), RERANKER_BATCH_SIZE):
                batch = documents[start : start + RERANKER_BATCH_SIZE]
                scores.extend(self._rerank_batch(query, batch))
        return scores

    def _encode(self, texts: Sequence[str], *, is_query: bool) -> list[list[float]]:
        import torch

        if self._embedding_model is None or self._embedding_tokenizer is None:
            raise RetrievalModelError("嵌入模型尚未加载")
        prepared = (
            [f"Instruct: {RETRIEVAL_INSTRUCTION}\nQuery:{text}" for text in texts]
            if is_query
            else list(texts)
        )
        inputs = self._embedding_tokenizer(
            prepared,
            padding=True,
            truncation=True,
            max_length=EMBEDDING_MAX_TOKENS,
            return_tensors="pt",
        )
        inputs = {name: value.to(self._device) for name, value in inputs.items()}
        with torch.inference_mode():
            output = self._embedding_model(**inputs)
            pooled = _last_token_pool(output.last_hidden_state, inputs["attention_mask"])
            pooled = pooled[:, : self.dimensions]
            normalized = torch.nn.functional.normalize(pooled.float(), p=2, dim=1)
        return normalized.cpu().tolist()

    def prepare_reranker(self, report_progress: ProgressReporter) -> None:
        with self._lock:
            if self._reranker_model is not None:
                return
            directory = self._ensure_installed(RERANKER_MODEL, report_progress)
            report_progress("loading_reranker_model", 0, 0)
            torch, _, auto_tokenizer = _transformer_runtime()
            from transformers import AutoModelForCausalLM

            device, dtype = _inference_device(torch)
            tokenizer = auto_tokenizer.from_pretrained(
                directory,
                local_files_only=True,
                padding_side="left",
            )
            model = AutoModelForCausalLM.from_pretrained(
                directory,
                local_files_only=True,
                dtype=dtype,
            )
            model.to(device)
            model.eval()
            self._device = device
            self._reranker_tokenizer = tokenizer
            self._reranker_model = model

    def _rerank_batch(self, query: str, documents: Sequence[str]) -> list[float]:
        import torch

        if self._reranker_model is None or self._reranker_tokenizer is None:
            raise RetrievalModelError("重排模型尚未加载")
        tokenizer = self._reranker_tokenizer
        prefix = (
            f"<|im_start|>system\n{RERANKER_SYSTEM_PROMPT}<|im_end|>\n"
            "<|im_start|>user\n"
        )
        prefix_tokens = tokenizer.encode(prefix, add_special_tokens=False)
        suffix_tokens = tokenizer.encode(RERANKER_SUFFIX, add_special_tokens=False)
        pairs = [
            f"<Instruct>: {RETRIEVAL_INSTRUCTION}\n<Query>: {query}\n<Document>: {document}"
            for document in documents
        ]
        encoded = tokenizer(
            pairs,
            padding=False,
            truncation="longest_first",
            return_attention_mask=False,
            max_length=RERANKER_MAX_TOKENS - len(prefix_tokens) - len(suffix_tokens),
        )
        encoded["input_ids"] = [
            prefix_tokens + token_ids + suffix_tokens
            for token_ids in encoded["input_ids"]
        ]
        inputs = tokenizer.pad(encoded, padding=True, return_tensors="pt")
        inputs = {name: value.to(self._device) for name, value in inputs.items()}
        true_token_id = tokenizer("yes", add_special_tokens=False).input_ids[0]
        false_token_id = tokenizer("no", add_special_tokens=False).input_ids[0]
        with torch.inference_mode():
            logits = self._reranker_model(**inputs).logits[:, -1, :]
            binary_logits = torch.stack(
                [logits[:, false_token_id], logits[:, true_token_id]],
                dim=1,
            )
            probabilities = torch.nn.functional.softmax(binary_logits.float(), dim=1)
        return probabilities[:, 1].cpu().tolist()

    def _ensure_installed(
        self,
        spec: RetrievalModelSpec,
        report_progress: ProgressReporter,
    ) -> Path:
        directory = self._model_directory(spec)
        manifest_path = directory / MODEL_MANIFEST_FILE_NAME
        if (
            _installed_manifest_matches(manifest_path, spec)
            and (directory / "config.json").is_file()
            and (directory / MODEL_WEIGHT_FILE_NAME).is_file()
        ):
            return directory
        report_progress(spec.download_stage, 0, 0)
        directory.mkdir(parents=True, exist_ok=True)
        _download_model_snapshot(spec, directory)
        _verify_model_snapshot(directory, spec)
        _write_manifest(manifest_path, spec)
        return directory

    def _model_directory(self, spec: RetrievalModelSpec) -> Path:
        base = (self.root_directory / spec.directory_name).resolve()
        directory = (base / spec.revision).resolve()
        if not directory.is_relative_to(self.root_directory):
            raise RetrievalModelError("检索模型目录无效")
        return directory


def _transformer_runtime():
    try:
        import torch
        from transformers import AutoModel, AutoTokenizer
    except ImportError as error:
        raise RetrievalModelError("神经检索运行依赖尚未安装") from error
    return torch, AutoModel, AutoTokenizer


def _inference_device(torch_module):
    if not torch_module.cuda.is_available():
        return torch_module.device("cpu"), torch_module.float32
    supports_bfloat16 = getattr(torch_module.cuda, "is_bf16_supported", lambda: False)
    dtype = torch_module.bfloat16 if supports_bfloat16() else torch_module.float16
    return torch_module.device("cuda"), dtype


def _last_token_pool(last_hidden_states, attention_mask):
    import torch

    if bool((attention_mask[:, -1].sum() == attention_mask.shape[0]).item()):
        return last_hidden_states[:, -1]
    sequence_lengths = attention_mask.sum(dim=1) - 1
    batch_indices = torch.arange(
        last_hidden_states.shape[0], device=last_hidden_states.device
    )
    return last_hidden_states[batch_indices, sequence_lengths]


def _installed_manifest_matches(
    manifest_path: Path,
    spec: RetrievalModelSpec,
) -> bool:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return manifest == {
        "repository": spec.repository,
        "revision": spec.revision,
        "weight_sha256": spec.weight_sha256,
    }


def _write_manifest(manifest_path: Path, spec: RetrievalModelSpec) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = manifest_path.with_name(f".{manifest_path.name}.tmp")
    temporary_path.write_text(
        json.dumps(
            {
                "repository": spec.repository,
                "revision": spec.revision,
                "weight_sha256": spec.weight_sha256,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    os.replace(temporary_path, manifest_path)


def _ignore_progress(stage: str, processed: int, total: int) -> None:
    del stage, processed, total


def _download_model_snapshot(spec: RetrievalModelSpec, directory: Path) -> None:
    try:
        _modelscope_snapshot_download(
            model_id=spec.repository,
            revision=spec.modelscope_revision,
            local_dir=str(directory),
        )
        return
    except Exception as modelscope_error:
        try:
            huggingface_snapshot_download(
                repo_id=spec.repository,
                revision=spec.revision,
                local_dir=directory,
            )
            return
        except Exception as huggingface_error:
            message = (
                f"{spec.repository} 无法从官方 ModelScope 或 Hugging Face 下载"
            )
            raise RetrievalModelError(message) from ExceptionGroup(
                message,
                [modelscope_error, huggingface_error],
            )


def _modelscope_snapshot_download(
    *,
    model_id: str,
    revision: str,
    local_dir: str,
) -> str:
    from modelscope import snapshot_download

    return snapshot_download(
        model_id=model_id,
        revision=revision,
        local_dir=local_dir,
    )


def _verify_model_snapshot(directory: Path, spec: RetrievalModelSpec) -> None:
    if not (directory / "config.json").is_file():
        raise RetrievalModelError(f"{spec.repository} 下载后缺少 config.json")
    weight_path = directory / MODEL_WEIGHT_FILE_NAME
    if not weight_path.is_file():
        raise RetrievalModelError(f"{spec.repository} 下载后缺少模型权重")
    digest = hashlib.sha256()
    with weight_path.open("rb") as weight_file:
        for chunk in iter(lambda: weight_file.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != spec.weight_sha256:
        raise RetrievalModelError(f"{spec.repository} 模型权重校验失败")
