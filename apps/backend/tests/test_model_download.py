import json
import time
from pathlib import Path

import pytest

from openvideo.core.model_download_models import (
    MODEL_MANIFEST_FILE_NAME,
    ModelResource,
    ModelResourceFile,
)
from openvideo.model_download import (
    ModelDownloadError,
    ModelSource,
    _validate_resource_files,
    ResolvedModelResource,
    _resolve_fastest_source,
    download_model_resources,
)


def _files() -> tuple[ModelResourceFile, ...]:
    return (
        ModelResourceFile(
            filename="model.bin",
            file_size=5,
            revision="revision",
        ),
    )


def test_auto_source_uses_the_first_responsive_official_mirror(
    tmp_path: Path,
    monkeypatch,
):
    resource = ModelResource("official/model", tmp_path / "model")

    def resolve(_resource, source):
        if source == ModelSource.MODELSCOPE:
            time.sleep(0.05)
        return _files()

    monkeypatch.delenv("OPENVIDEO_MODEL_SOURCE", raising=False)
    monkeypatch.setattr("openvideo.model_download._resolve_source_files", resolve)

    resolved = _resolve_fastest_source(resource)

    assert resolved.source == ModelSource.HUGGINGFACE


def test_download_failure_switches_source_and_keeps_one_verified_install(
    tmp_path: Path,
    monkeypatch,
):
    resource = ModelResource("official/model", tmp_path / "model")
    monkeypatch.setenv("OPENVIDEO_MODEL_SOURCE", "modelscope")
    monkeypatch.setattr(
        "openvideo.model_download._resolve_modelscope_resource_files",
        lambda _resource: _files(),
    )
    monkeypatch.setattr(
        "openvideo.model_download._resolve_huggingface_resource_files",
        lambda _resource: _files(),
    )
    monkeypatch.setattr(
        "openvideo.model_download._modelscope_snapshot_download",
        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("国内连接中断")),
    )

    def download(_repository, filename, *_args, **kwargs):
        output_path = Path(kwargs["local_dir"]) / filename
        output_path.write_bytes(b"model")

    monkeypatch.setattr("openvideo.model_download.hf_hub_download", download)
    progress: list[tuple[int, int]] = []

    download_model_resources(
        [resource],
        lambda downloaded, total: progress.append((downloaded, total)),
    )

    manifest = json.loads(
        (resource.directory / MODEL_MANIFEST_FILE_NAME).read_text(encoding="utf-8")
    )
    assert manifest["source"] == "huggingface"
    assert progress[0] == (0, 5)
    assert progress[-1] == (5, 5)


def test_both_source_failures_remain_visible_in_one_error(
    tmp_path: Path,
    monkeypatch,
):
    resource = ModelResource("official/model", tmp_path / "model")
    monkeypatch.setenv("OPENVIDEO_MODEL_SOURCE", "modelscope")
    monkeypatch.setattr(
        "openvideo.model_download._resolve_modelscope_resource_files",
        lambda _resource: _files(),
    )
    monkeypatch.setattr(
        "openvideo.model_download._resolve_huggingface_resource_files",
        lambda _resource: _files(),
    )
    monkeypatch.setattr(
        "openvideo.model_download._modelscope_snapshot_download",
        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("国内失败")),
    )
    monkeypatch.setattr(
        "openvideo.model_download.hf_hub_download",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("海外失败")),
    )

    with pytest.raises(ModelDownloadError) as failure:
        download_model_resources([resource], lambda *_: None)

    assert "国内源：国内失败" in str(failure.value)
    assert "海外源：海外失败" in str(failure.value)


def test_remote_file_path_cannot_escape_the_managed_model_directory(
    tmp_path: Path,
):
    resource = ModelResource("official/model", tmp_path / "model")
    resolved = ResolvedModelResource(
        resource=resource,
        source=ModelSource.HUGGINGFACE,
        files=(
            ModelResourceFile(
                filename="../outside.bin",
                file_size=5,
                revision="revision",
            ),
        ),
    )

    with pytest.raises(ModelDownloadError, match="模型文件路径无效"):
        _validate_resource_files(resolved)
