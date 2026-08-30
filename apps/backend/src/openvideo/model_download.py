"""在国内外官方模型源之间自动择路并校验断点下载。"""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Sequence
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError, as_completed
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from threading import Event, Thread

from huggingface_hub import HfApi, hf_hub_download

from openvideo.core.model_download_models import (
    MODEL_MANIFEST_FILE_NAME,
    ModelResource,
    ModelResourceFile,
)


MODEL_SOURCE_ENVIRONMENT = "OPENVIDEO_MODEL_SOURCE"
MODEL_SOURCE_RESOLUTION_TIMEOUT_SECONDS = 8
DOWNLOAD_PROGRESS_INTERVAL_SECONDS = 0.25
MODEL_SOURCE_LABELS = {
    "modelscope": "国内源",
    "huggingface": "海外源",
}


class ModelSource(StrEnum):
    MODELSCOPE = "modelscope"
    HUGGINGFACE = "huggingface"


class ModelDownloadError(RuntimeError):
    """所有官方源均无法解析、下载或完整校验模型时抛出。"""


@dataclass(frozen=True)
class ResolvedModelResource:
    resource: ModelResource
    source: ModelSource
    files: tuple[ModelResourceFile, ...]


def download_model_resources(
    resources: Sequence[ModelResource],
    progress_callback: Callable[[int, int], None],
) -> None:
    resolved_resources = [_resolve_fastest_source(resource) for resource in resources]
    total_bytes = sum(
        file.file_size
        for resolved in resolved_resources
        for file in resolved.files
    )
    downloaded_bytes = 0
    progress_callback(downloaded_bytes, total_bytes)
    for resolved in resolved_resources:
        try:
            _download_resolved_resource(
                resolved,
                downloaded_bytes,
                total_bytes,
                progress_callback,
            )
        except Exception as primary_error:
            fallback_source = _alternate_source(resolved.source)
            try:
                fallback = _resolve_source(resolved.resource, fallback_source)
            except Exception as fallback_error:
                raise ModelDownloadError(
                    _combined_source_error(
                        resolved.resource,
                        resolved.source,
                        primary_error,
                        fallback_source,
                        fallback_error,
                    )
                ) from fallback_error
            fallback_size = sum(file.file_size for file in fallback.files)
            primary_size = sum(file.file_size for file in resolved.files)
            total_bytes += fallback_size - primary_size
            progress_callback(downloaded_bytes, total_bytes)
            try:
                _download_resolved_resource(
                    fallback,
                    downloaded_bytes,
                    total_bytes,
                    progress_callback,
                )
            except Exception as fallback_error:
                raise ModelDownloadError(
                    _combined_source_error(
                        resolved.resource,
                        resolved.source,
                        primary_error,
                        fallback.source,
                        fallback_error,
                    )
                ) from fallback_error
            resolved = fallback
        downloaded_bytes += sum(file.file_size for file in resolved.files)
        progress_callback(downloaded_bytes, total_bytes)
        _write_resource_manifest(resolved)


def _resolve_fastest_source(resource: ModelResource) -> ResolvedModelResource:
    preferred = os.getenv(MODEL_SOURCE_ENVIRONMENT, "auto").strip().lower()
    if preferred in {source.value for source in ModelSource}:
        return _resolve_source(resource, ModelSource(preferred))
    if preferred != "auto":
        raise ModelDownloadError(
            f"{MODEL_SOURCE_ENVIRONMENT} 仅支持 auto、modelscope 或 huggingface"
        )

    executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="model-source")
    futures: dict[Future[tuple[ModelResourceFile, ...]], ModelSource] = {
        executor.submit(_resolve_source_files, resource, source): source
        for source in ModelSource
    }
    failures: dict[ModelSource, Exception] = {}
    try:
        for future in as_completed(
            futures,
            timeout=MODEL_SOURCE_RESOLUTION_TIMEOUT_SECONDS,
        ):
            source = futures[future]
            try:
                return ResolvedModelResource(resource, source, future.result())
            except Exception as error:
                failures[source] = error
    except TimeoutError:
        pass
    finally:
        executor.shutdown(wait=False, cancel_futures=True)
    details = "；".join(
        f"{MODEL_SOURCE_LABELS[source.value]}：{error}"
        for source, error in failures.items()
    )
    if not details:
        details = "连接官方模型源超时"
    raise ModelDownloadError(f"无法读取 {resource.repository} 文件清单：{details}")


def _resolve_source(
    resource: ModelResource,
    source: ModelSource,
) -> ResolvedModelResource:
    try:
        files = _resolve_source_files(resource, source)
    except Exception as error:
        raise ModelDownloadError(
            f"{MODEL_SOURCE_LABELS[source.value]}无法读取 {resource.repository}：{error}"
        ) from error
    return ResolvedModelResource(resource, source, files)


def _resolve_source_files(
    resource: ModelResource,
    source: ModelSource,
) -> tuple[ModelResourceFile, ...]:
    if source == ModelSource.MODELSCOPE:
        return _resolve_modelscope_resource_files(resource)
    return _resolve_huggingface_resource_files(resource)


def _resolve_modelscope_resource_files(
    resource: ModelResource,
) -> tuple[ModelResourceFile, ...]:
    from modelscope.hub.api import HubApi

    raw_files = HubApi().get_model_files(
        resource.repository,
        revision="master",
        recursive=True,
    )
    files = tuple(
        ModelResourceFile(
            filename=str(file["Path"]),
            file_size=int(file["Size"]),
            revision="master",
        )
        for file in raw_files
        if int(file.get("Size", 0)) > 0
    )
    if not files:
        raise ModelDownloadError("官方模型文件清单无效")
    return files


def _resolve_huggingface_resource_files(
    resource: ModelResource,
) -> tuple[ModelResourceFile, ...]:
    resource.directory.mkdir(parents=True, exist_ok=True)
    model_info = HfApi().model_info(resource.repository, files_metadata=True)
    if not model_info.sha:
        raise ModelDownloadError("官方模型文件清单无效")
    files = tuple(
        ModelResourceFile(
            filename=file.rfilename,
            file_size=file.size,
            revision=model_info.sha,
        )
        for file in model_info.siblings
        if file.size is not None
    )
    if not files or len(files) != len(model_info.siblings):
        raise ModelDownloadError("官方模型文件清单无效")
    return files


def _download_resolved_resource(
    resolved: ResolvedModelResource,
    completed_bytes: int,
    total_bytes: int,
    progress_callback: Callable[[int, int], None],
) -> None:
    resolved.resource.directory.mkdir(parents=True, exist_ok=True)

    def download() -> None:
        if resolved.source == ModelSource.MODELSCOPE:
            _modelscope_snapshot_download(
                model_id=resolved.resource.repository,
                revision=resolved.files[0].revision,
                local_dir=str(resolved.resource.directory),
            )
            return
        for file in resolved.files:
            hf_hub_download(
                resolved.resource.repository,
                file.filename,
                revision=file.revision,
                local_dir=resolved.resource.directory,
            )

    _run_with_file_progress(
        download,
        resolved,
        completed_bytes,
        total_bytes,
        progress_callback,
    )
    _validate_resource_files(resolved)


def _run_with_file_progress(
    download: Callable[[], None],
    resolved: ResolvedModelResource,
    completed_bytes: int,
    total_bytes: int,
    progress_callback: Callable[[int, int], None],
) -> None:
    finished = Event()
    failure: list[BaseException] = []

    def run() -> None:
        try:
            download()
        except BaseException as error:
            failure.append(error)
        finally:
            finished.set()

    worker = Thread(target=run, name="model-download", daemon=True)
    worker.start()
    while not finished.wait(DOWNLOAD_PROGRESS_INTERVAL_SECONDS):
        current_bytes = _downloaded_resource_bytes(resolved)
        progress_callback(completed_bytes + current_bytes, total_bytes)
    worker.join()
    if failure:
        raise failure[0]


def _downloaded_resource_bytes(resolved: ResolvedModelResource) -> int:
    expected_bytes = sum(file.file_size for file in resolved.files)
    completed_bytes = sum(
        min(_file_size(_resource_file_path(resolved.resource, file)), file.file_size)
        for file in resolved.files
    )
    try:
        incomplete_bytes = sum(
            _file_size(path)
            for path in resolved.resource.directory.rglob("*.incomplete")
        )
    except OSError:
        incomplete_bytes = 0
    return min(completed_bytes + incomplete_bytes, expected_bytes)


def _validate_resource_files(resolved: ResolvedModelResource) -> None:
    for file in resolved.files:
        downloaded_file = _resource_file_path(resolved.resource, file)
        if (
            not downloaded_file.is_file()
            or downloaded_file.stat().st_size != file.file_size
        ):
            raise ModelDownloadError(
                f"{resolved.resource.repository} 官方模型文件校验失败：{file.filename}"
            )


def _resource_file_path(
    resource: ModelResource,
    file: ModelResourceFile,
) -> Path:
    root_directory = resource.directory.resolve()
    file_path = (root_directory / file.filename).resolve()
    if not file_path.is_relative_to(root_directory):
        raise ModelDownloadError(
            f"{resource.repository} 官方模型文件路径无效：{file.filename}"
        )
    return file_path


def _file_size(path: Path) -> int:
    try:
        return path.stat().st_size if path.is_file() else 0
    except OSError:
        return 0


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


def _write_resource_manifest(resolved: ResolvedModelResource) -> None:
    manifest_path = resolved.resource.directory / MODEL_MANIFEST_FILE_NAME
    temporary_manifest_path = manifest_path.with_suffix(".tmp")
    temporary_manifest_path.write_text(
        json.dumps(
            {
                "repository": resolved.resource.repository,
                "source": resolved.source.value,
                "revision": resolved.files[0].revision,
                "installed_at": datetime.now(UTC).isoformat(),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    temporary_manifest_path.replace(manifest_path)


def _alternate_source(source: ModelSource) -> ModelSource:
    return (
        ModelSource.HUGGINGFACE
        if source == ModelSource.MODELSCOPE
        else ModelSource.MODELSCOPE
    )


def _combined_source_error(
    resource: ModelResource,
    primary_source: ModelSource,
    primary_error: Exception,
    fallback_source: ModelSource,
    fallback_error: Exception,
) -> str:
    return (
        f"无法下载 {resource.repository}；"
        f"{MODEL_SOURCE_LABELS[primary_source.value]}：{primary_error}；"
        f"{MODEL_SOURCE_LABELS[fallback_source.value]}：{fallback_error}"
    )
