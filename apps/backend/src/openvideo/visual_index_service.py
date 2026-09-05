"""按需下载、构建、查询并释放 SigLIP2 视觉检索索引。"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
import gc
import hashlib
import json
import math
import os
from pathlib import Path
import re
from threading import Event, RLock

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
VISUAL_MODEL_DIMENSIONS = 768
FRAME_FILE_TIME_PATTERN = re.compile(r"^frame_\d+_(?P<seconds>\d+(?:\.\d+)?)s\.[^.]+$")


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
    dimensions = VISUAL_MODEL_DIMENSIONS

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
        self._loaded = Event()

    @property
    def loaded(self) -> bool:
        return self._loaded.is_set()

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
            self._loaded.set()

    def encode_images(
        self,
        image_paths: Sequence[Path],
        report_progress: ProgressReporter,
    ) -> list[list[float]]:
        vectors: list[list[float]] = []
        total = len(image_paths)
        with self._lock:
            self.prepare()
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
        with self._lock:
            self.prepare()
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
            self._loaded.clear()
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
        self._pending_assets: set[str] = set()
        self._pending_all_assets = False
        self._asset_waiters: dict[str, list[asyncio.Future[bool]]] = {}
        self._frame_digests: dict[Path, tuple[tuple[int, int, int], str]] = {}

    def status(self) -> VisualIndexStatus:
        persisted = self.library.load_visual_index_status()
        status = persisted or VisualIndexStatus(
            model_name=self.encoder.model_name,
            model_revision=self.encoder.model_revision,
        )
        if (
            status.model_name != self.encoder.model_name
            or status.model_revision != self.encoder.model_revision
        ):
            status = VisualIndexStatus(
                model_name=self.encoder.model_name,
                model_revision=self.encoder.model_revision,
            )
        return status.model_copy(update={"model_loaded": self.encoder.loaded})

    def prepare(self, asset_id: str | None = None) -> VisualIndexStatus:
        if asset_id is not None and self.library.get(asset_id) is None:
            raise ValueError("视频素材不存在")
        with self._lock:
            self._loop = asyncio.get_running_loop()
            if asset_id is None:
                self._pending_all_assets = True
            else:
                self._pending_assets.add(asset_id)
            if self._task is not None and not self._task.done():
                return self.status()
            if self._unload_task is not None:
                self._unload_task.cancel()
                self._unload_task = None
            self._save_status(
                state=VisualIndexState.INDEXING,
                progress_percent=0,
                message="正在检查当前视频的画面索引",
                error_message=None,
            )
            self._task = asyncio.create_task(self._build())
        return self.status()

    async def ensure_ready(self, asset_id: str) -> bool:
        """等待请求素材完成增量检查，单个消费者取消时仍保留共享后台任务。"""
        if self.library.get(asset_id) is None:
            return False
        completion = asyncio.get_running_loop().create_future()
        self._asset_waiters.setdefault(asset_id, []).append(completion)
        try:
            self.prepare(asset_id)
            return await completion
        finally:
            if not completion.done():
                completion.cancel()
            waiters = self._asset_waiters.get(asset_id)
            if waiters is not None and completion in waiters:
                waiters.remove(completion)
                if not waiters:
                    self._asset_waiters.pop(asset_id)

    def is_ready(self, asset_id: str) -> bool:
        """按当前关键帧内容判断素材覆盖，整体状态不代表每个视频均已建索引。"""
        embeddings = self.library.load_visual_frame_embeddings(
            asset_id=asset_id,
            model_name=self.encoder.model_name,
            model_revision=self.encoder.model_revision,
            dimensions=self.encoder.dimensions,
        )
        if not embeddings:
            return False
        frames = self._frame_references(asset_id)
        current = {
            (frame.relative_path, frame.seconds, frame.content_digest)
            for frame in frames
        }
        cached = {
            (item.relative_path, item.seconds, item.content_digest)
            for item in embeddings
        }
        return bool(current) and current == cached

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
        if limit <= 0 or not query.strip():
            return []
        embeddings = self.library.load_visual_frame_embeddings(
            asset_id=asset_id,
            model_name=self.encoder.model_name,
            model_revision=self.encoder.model_revision,
            dimensions=self.encoder.dimensions,
        )
        if not embeddings:
            return []
        current_frames = {
            frame.relative_path: frame
            for frame in self._frame_references(asset_id, verify_content=False)
        }
        embeddings = [
            item
            for item in embeddings
            if item.relative_path in current_frames
            and current_frames[item.relative_path].content_digest == item.content_digest
        ]
        if not embeddings:
            return []
        query_vector = self.encoder.encode_text(query)
        if len(query_vector) != self.encoder.dimensions or not all(
            math.isfinite(value) for value in query_vector
        ):
            return []
        matches = []
        for item in embeddings:
            score = sum(
                left * right
                for left, right in zip(query_vector, item.vector, strict=True)
            )
            matches.append(
                VisualFrameMatch(
                    asset_id=asset_id,
                    relative_path=item.relative_path,
                    seconds=current_frames[item.relative_path].seconds,
                    similarity=max(-1.0, min(1.0, score)),
                )
            )
        matches.sort(key=lambda item: (-item.similarity, item.seconds))
        self._schedule_unload_threadsafe()
        return matches[:limit]

    async def _build(self) -> None:
        completed: dict[str, int] = {}
        failures: dict[str, str] = {}
        batch_waiters: dict[str, list[asyncio.Future[bool]]] = {}
        try:
            while True:
                with self._lock:
                    requested_assets = self._pending_assets
                    self._pending_assets = set()
                    if self._pending_all_assets:
                        requested_assets.update(
                            asset.asset_id for asset in self.library.list()
                        )
                        self._pending_all_assets = False
                    batch_waiters = {
                        asset_id: self._asset_waiters.pop(asset_id, [])
                        for asset_id in requested_assets
                    }
                for asset_id in sorted(requested_assets):
                    ready = False
                    try:
                        frame_count = await self._build_asset(asset_id)
                        completed[asset_id] = frame_count
                        failures.pop(asset_id, None)
                        ready = (
                            bool(frame_count) and self.library.get(asset_id) is not None
                        )
                    except Exception as error:
                        if self.library.get(asset_id) is None:
                            completed[asset_id] = 0
                            failures.pop(asset_id, None)
                        else:
                            failures[asset_id] = str(error) or "视觉索引准备失败"
                    finally:
                        for completion in batch_waiters.pop(asset_id, []):
                            if not completion.done():
                                completion.set_result(ready)
                with self._lock:
                    if not self._pending_assets and not self._pending_all_assets:
                        break
            indexed = sum(completed.values())
            self._save_status(
                state=VisualIndexState.ERROR if failures else VisualIndexState.READY,
                progress_percent=100,
                message="部分视频的视觉索引准备失败"
                if failures
                else f"视觉索引已就绪，共 {indexed} 帧",
                indexed_frames=indexed,
                total_frames=indexed,
                error_message="；".join(failures.values()) if failures else None,
            )
        except asyncio.CancelledError:
            raise
        finally:
            for waiters in (*batch_waiters.values(), *self._asset_waiters.values()):
                for completion in waiters:
                    if not completion.done():
                        completion.set_result(False)
            self._asset_waiters.clear()
            if self.encoder.loaded:
                self._schedule_unload()

    async def _build_asset(self, asset_id: str) -> int:
        if self.library.get(asset_id) is None:
            return 0
        frames = await asyncio.to_thread(self._frame_references, asset_id)
        embeddings = self.library.load_visual_frame_embeddings(
            asset_id=asset_id,
            model_name=self.encoder.model_name,
            model_revision=self.encoder.model_revision,
            dimensions=self.encoder.dimensions,
        )
        vectors_by_digest = {item.content_digest: item.vector for item in embeddings}
        pending: dict[str, VisualFrameReference] = {}
        for frame in frames:
            if frame.content_digest not in vectors_by_digest:
                pending.setdefault(frame.content_digest, frame)
        if pending:
            self._save_status(
                state=VisualIndexState.DOWNLOADING,
                progress_percent=0,
                message="正在按需准备 SigLIP2 视觉模型",
                indexed_frames=0,
                total_frames=len(pending),
                error_message=None,
            )
            await asyncio.to_thread(self.encoder.prepare)

            def report(processed: int, total: int) -> None:
                self._save_status(
                    state=VisualIndexState.INDEXING,
                    progress_percent=100 * processed / max(total, 1),
                    message=f"正在计算新增画面 {processed}/{total}",
                    indexed_frames=processed,
                    total_frames=total,
                )

            vectors = await asyncio.to_thread(
                self.encoder.encode_images,
                [frame.absolute_path for frame in pending.values()],
                report,
            )
            if len(vectors) != len(pending):
                raise ValueError("视觉向量数量与新增关键帧数量不一致")
            vectors_by_digest.update(zip(pending, vectors, strict=True))
        return await asyncio.to_thread(
            self._commit_asset_frames, asset_id, frames, vectors_by_digest
        )

    def _commit_asset_frames(
        self,
        asset_id: str,
        frames: list[VisualFrameReference],
        vectors_by_digest: dict[str, list[float]],
    ) -> int:
        """提交前重查实际帧内容，并阻止素材编辑穿过校验与原子替换之间。"""
        with self.library._lock:
            if self.library.get(asset_id) is None:
                return 0
            if frames != self._frame_references(asset_id):
                raise ValueError("关键帧在索引期间发生变化，请重新准备视觉索引")
            self.library.replace_visual_frame_embeddings(
                asset_id=asset_id,
                model_name=self.encoder.model_name,
                model_revision=self.encoder.model_revision,
                dimensions=self.encoder.dimensions,
                frames=[
                    (
                        frame.relative_path,
                        frame.seconds,
                        frame.content_digest,
                        vectors_by_digest[frame.content_digest],
                    )
                    for frame in frames
                ],
            )
            return len(frames)

    def _frame_references(
        self,
        asset_id: str | None,
        *,
        verify_content: bool = True,
    ) -> list[VisualFrameReference]:
        assets = (
            [self.library.get(asset_id)]
            if asset_id is not None
            else self.library.list()
        )
        references: dict[tuple[str, str], VisualFrameReference] = {}
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
                    filename_time = FRAME_FILE_TIME_PATTERN.fullmatch(
                        absolute_path.name
                    )
                    if filename_time is not None:
                        seconds = float(filename_time.group("seconds"))
                    try:
                        content_digest = self._frame_content_digest(
                            absolute_path, verify_content=verify_content
                        )
                    except OSError:
                        continue
                    reference = VisualFrameReference(
                        asset_id=asset.asset_id,
                        relative_path=relative_path,
                        absolute_path=absolute_path,
                        seconds=round(seconds, 3),
                        content_digest=content_digest,
                    )
                    references.setdefault((asset.asset_id, relative_path), reference)
        return list(references.values())

    def _frame_content_digest(self, path: Path, *, verify_content: bool) -> str:
        """重建强校验内容，连续搜索仅复用文件元数据仍一致的校验结果。"""
        stat = path.stat()
        signature = (stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
        cached = self._frame_digests.get(path)
        if not verify_content and cached is not None and cached[0] == signature:
            return cached[1]
        digest = _sha256(path)
        self._frame_digests[path] = (signature, digest)
        return digest

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
