"""按需下载、构建、查询并释放 SigLIP2 视觉检索索引。"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
import gc
import hashlib
import json
import os
from pathlib import Path
from threading import RLock

from huggingface_hub import snapshot_download
from PIL import Image

from openvideo.core.library import MediaLibrary
from openvideo.core.model_download_models import MODEL_MANIFEST_FILE_NAME
from openvideo.core.visual_index_models import (
    VisualFrameMatch,
    VisualIndexState,
    VisualIndexStatus,
)
from openvideo.settings import Settings


VISUAL_MODEL_NAME = "google/siglip2-base-patch16-224"
VISUAL_MODEL_REVISION = "997aaec1bf5d39abda33ef9b28b83d8172c33f64"
VISUAL_MODEL_WEIGHT_SHA256 = (
    "612923381c76ec5a9bed335d1c48827e3f2e506ac31b044b63b2031fadee6a0b"
)
VISUAL_INDEX_DIRECTORY_NAME = "visual-retrieval"
VISUAL_MODEL_DIRECTORY_NAME = "siglip2-base-patch16-224"
VISUAL_MODEL_WEIGHT_FILE_NAME = "model.safetensors"
VISUAL_MODEL_IDLE_SECONDS = 300
VISUAL_INDEX_BATCH_SIZE = 8
VISUAL_TEXT_MAX_TOKENS = 64


ProgressReporter = Callable[[int, int], None]


@dataclass(frozen=True)
class VisualFrameReference:
    asset_id: str
    relative_path: str
    absolute_path: Path
    seconds: float
    content_digest: str


class VisualEncoder:
    """SigLIP2 只在显式准备或查询时加载，不参与应用启动。"""

    model_name = VISUAL_MODEL_NAME
    model_revision = VISUAL_MODEL_REVISION

    def __init__(self, root_directory: Path) -> None:
        self.root_directory = root_directory.resolve()
        self.model_directory = (
            self.root_directory / VISUAL_MODEL_DIRECTORY_NAME / VISUAL_MODEL_REVISION
        ).resolve()
        if not self.model_directory.is_relative_to(self.root_directory):
            raise ValueError("视觉模型目录无效")
        self._processor = None
        self._model = None
        self._device = None
        self._lock = RLock()

    @property
    def loaded(self) -> bool:
        with self._lock:
            return self._model is not None

    def prepare(self) -> None:
        with self._lock:
            if self._model is not None:
                return
            self._ensure_installed()
            torch, auto_model, auto_processor = _transformer_runtime()
            device, dtype = _inference_device(torch)
            processor = auto_processor.from_pretrained(
                self.model_directory,
                local_files_only=True,
            )
            model = auto_model.from_pretrained(
                self.model_directory,
                local_files_only=True,
                dtype=dtype,
                trust_remote_code=False,
            )
            model.to(device)
            model.eval()
            self._processor = processor
            self._model = model
            self._device = device

    def encode_images(
        self,
        image_paths: Sequence[Path],
        report_progress: ProgressReporter,
    ) -> list[list[float]]:
        self.prepare()
        vectors: list[list[float]] = []
        total = len(image_paths)
        with self._lock:
            for start in range(0, total, VISUAL_INDEX_BATCH_SIZE):
                batch_paths = image_paths[start : start + VISUAL_INDEX_BATCH_SIZE]
                images = []
                try:
                    for path in batch_paths:
                        images.append(Image.open(path).convert("RGB"))
                    inputs = self._processor(
                        images=images,
                        return_tensors="pt",
                    )
                    vectors.extend(self._image_features(inputs))
                finally:
                    for image in images:
                        image.close()
                report_progress(min(start + len(batch_paths), total), total)
        return vectors

    def encode_text(self, query: str) -> list[float]:
        self.prepare()
        with self._lock:
            inputs = self._processor(
                text=[query],
                padding="max_length",
                max_length=VISUAL_TEXT_MAX_TOKENS,
                return_tensors="pt",
            )
            inputs = {name: value.to(self._device) for name, value in inputs.items()}
            torch, _, _ = _transformer_runtime()
            with torch.inference_mode():
                features = self._model.get_text_features(**inputs)
                normalized = torch.nn.functional.normalize(features.float(), p=2, dim=1)
            return normalized[0].cpu().tolist()

    def unload(self) -> None:
        with self._lock:
            self._processor = None
            self._model = None
            self._device = None
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            return

    def _image_features(self, inputs: object) -> list[list[float]]:
        torch, _, _ = _transformer_runtime()
        prepared = {name: value.to(self._device) for name, value in inputs.items()}
        with torch.inference_mode():
            features = self._model.get_image_features(**prepared)
            normalized = torch.nn.functional.normalize(features.float(), p=2, dim=1)
        return normalized.cpu().tolist()

    def _ensure_installed(self) -> None:
        manifest_path = self.model_directory / MODEL_MANIFEST_FILE_NAME
        weight_path = self.model_directory / VISUAL_MODEL_WEIGHT_FILE_NAME
        expected_manifest = {
            "repository": VISUAL_MODEL_NAME,
            "revision": VISUAL_MODEL_REVISION,
            "weight_sha256": VISUAL_MODEL_WEIGHT_SHA256,
        }
        try:
            installed_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            installed_manifest = None
        if installed_manifest == expected_manifest and weight_path.is_file():
            return
        self.model_directory.mkdir(parents=True, exist_ok=True)
        snapshot_download(
            repo_id=VISUAL_MODEL_NAME,
            revision=VISUAL_MODEL_REVISION,
            local_dir=self.model_directory,
        )
        if not weight_path.is_file():
            raise RuntimeError("SigLIP2 下载后缺少模型权重")
        if _sha256(weight_path) != VISUAL_MODEL_WEIGHT_SHA256:
            raise RuntimeError("SigLIP2 模型权重校验失败")
        temporary = manifest_path.with_name(f".{manifest_path.name}.tmp")
        temporary.write_text(
            json.dumps(expected_manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(temporary, manifest_path)


class VisualIndexService:
    """视觉索引是显式后台能力；状态查询不会下载、加载或扫描视频。"""

    def __init__(
        self,
        library: MediaLibrary,
        settings: Settings,
        encoder: VisualEncoder | None = None,
    ) -> None:
        self.library = library
        self.settings = settings
        self.encoder = encoder or VisualEncoder(
            settings.models_root_directory / VISUAL_INDEX_DIRECTORY_NAME
        )
        self._task: asyncio.Task[None] | None = None
        self._unload_task: asyncio.Task[None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = RLock()

    def status(self) -> VisualIndexStatus:
        persisted = self.library.load_visual_index_status()
        status = persisted or VisualIndexStatus(
            model_name=self.encoder.model_name,
            model_revision=self.encoder.model_revision,
        )
        return status.model_copy(update={"model_loaded": self.encoder.loaded})

    def prepare(self, asset_id: str | None = None) -> VisualIndexStatus:
        if asset_id is not None and self.library.get(asset_id) is None:
            raise ValueError("视频素材不存在")
        with self._lock:
            if self._task is not None and not self._task.done():
                return self.status()
            self._loop = asyncio.get_running_loop()
            self._task = asyncio.create_task(self._build(asset_id))
        return self.status()

    def unload(self) -> VisualIndexStatus:
        if self._unload_task is not None:
            self._unload_task.cancel()
            self._unload_task = None
        self.encoder.unload()
        return self.status()

    def search(
        self,
        asset_id: str,
        query: str,
        limit: int = 6,
    ) -> list[VisualFrameMatch]:
        vectors = self.library.load_visual_frame_vectors(
            asset_id=asset_id,
            model_name=self.encoder.model_name,
            model_revision=self.encoder.model_revision,
        )
        if not vectors:
            return []
        query_vector = self.encoder.encode_text(query)
        matches = [
            VisualFrameMatch(
                asset_id=asset_id,
                relative_path=relative_path,
                seconds=seconds,
                similarity=sum(
                    left * right
                    for left, right in zip(query_vector, vector, strict=True)
                ),
            )
            for relative_path, seconds, vector in vectors
            if len(query_vector) == len(vector)
        ]
        matches.sort(key=lambda item: (-item.similarity, item.seconds))
        self._schedule_unload_threadsafe()
        return matches[:limit]

    async def _build(self, asset_id: str | None) -> None:
        try:
            frames = self._frame_references(asset_id)
            self._save_status(
                state=VisualIndexState.DOWNLOADING,
                progress_percent=2,
                message="正在按需准备 SigLIP2 视觉模型",
                indexed_frames=0,
                total_frames=len(frames),
                error_message=None,
            )
            await asyncio.to_thread(self.encoder.prepare)
            self._save_status(
                state=VisualIndexState.LOADING,
                progress_percent=8,
                message="视觉模型已加载，正在准备关键帧",
                indexed_frames=0,
                total_frames=len(frames),
            )
            grouped: dict[str, list[VisualFrameReference]] = {}
            for frame in frames:
                grouped.setdefault(frame.asset_id, []).append(frame)
            indexed = 0
            total = len(frames)
            for current_asset_id, asset_frames in grouped.items():

                def report(processed: int, _batch_total: int) -> None:
                    current = indexed + processed
                    self._save_status(
                        state=VisualIndexState.INDEXING,
                        progress_percent=8 + 90 * current / max(total, 1),
                        message=f"正在建立画面索引 {current}/{total}",
                        indexed_frames=current,
                        total_frames=total,
                    )

                vectors = await asyncio.to_thread(
                    self.encoder.encode_images,
                    [frame.absolute_path for frame in asset_frames],
                    report,
                )
                self.library.replace_visual_frame_embeddings(
                    asset_id=current_asset_id,
                    model_name=self.encoder.model_name,
                    model_revision=self.encoder.model_revision,
                    dimensions=len(vectors[0]) if vectors else 0,
                    frames=[
                        (
                            frame.relative_path,
                            frame.seconds,
                            frame.content_digest,
                            vector,
                        )
                        for frame, vector in zip(asset_frames, vectors, strict=True)
                    ],
                )
                indexed += len(vectors)
            self._save_status(
                state=VisualIndexState.READY,
                progress_percent=100,
                message=f"视觉索引已就绪，共 {indexed} 帧",
                indexed_frames=indexed,
                total_frames=total,
            )
            self._schedule_unload()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self._save_status(
                state=VisualIndexState.ERROR,
                progress_percent=100,
                message="视觉索引准备失败",
                error_message=str(error) or "视觉索引准备失败",
            )

    def _frame_references(
        self,
        asset_id: str | None,
    ) -> list[VisualFrameReference]:
        assets = (
            [self.library.get(asset_id)]
            if asset_id is not None
            else self.library.list()
        )
        references: list[VisualFrameReference] = []
        for asset in assets:
            if asset is None:
                continue
            for segment in self.library.load_segments(asset.asset_id):
                frame_count = len(segment.key_frame_paths)
                for position, relative_path in enumerate(segment.key_frame_paths):
                    absolute_path = self.library.resolve_asset_file(
                        asset,
                        relative_path,
                    )
                    if absolute_path is None:
                        continue
                    seconds = segment.start_seconds + (
                        (segment.end_seconds - segment.start_seconds)
                        * (position + 1)
                        / (frame_count + 1)
                    )
                    references.append(
                        VisualFrameReference(
                            asset_id=asset.asset_id,
                            relative_path=relative_path,
                            absolute_path=absolute_path,
                            seconds=round(seconds, 3),
                            content_digest=_frame_digest(absolute_path),
                        )
                    )
        return references

    def _save_status(self, **updates: object) -> None:
        status = self.status().model_copy(
            update={**updates, "updated_at": datetime.now(UTC)},
        )
        self.library.save_visual_index_status(status)

    def _schedule_unload_threadsafe(self) -> None:
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._schedule_unload)

    def _schedule_unload(self) -> None:
        if self._unload_task is not None:
            self._unload_task.cancel()
        self._unload_task = asyncio.create_task(self._unload_after_idle())

    async def _unload_after_idle(self) -> None:
        try:
            await asyncio.sleep(VISUAL_MODEL_IDLE_SECONDS)
            await asyncio.to_thread(self.encoder.unload)
        except asyncio.CancelledError:
            return


def _transformer_runtime():
    try:
        import torch
        from transformers import AutoModel, AutoProcessor
    except ImportError as error:
        raise RuntimeError("视觉检索运行依赖尚未安装") from error
    return torch, AutoModel, AutoProcessor


def _inference_device(torch_module):
    if not torch_module.cuda.is_available():
        return torch_module.device("cpu"), torch_module.float32
    supports_bfloat16 = getattr(torch_module.cuda, "is_bf16_supported", lambda: False)
    dtype = torch_module.bfloat16 if supports_bfloat16() else torch_module.float16
    return torch_module.device("cuda"), dtype


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _frame_digest(path: Path) -> str:
    stat = path.stat()
    value = f"{path.name}:{stat.st_size}:{stat.st_mtime_ns}"
    return hashlib.sha256(value.encode()).hexdigest()
