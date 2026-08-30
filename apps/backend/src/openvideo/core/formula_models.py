"""视频画面公式识别所需的受管模型资源。"""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, Field

from openvideo.core.model_download_models import (
    ModelDownloadJob,
    ModelInstallationStatus,
    ModelResource,
    model_resource_is_installed,
)


FORMULA_MODELS_DIRECTORY_NAME = "formula-recognition"
FORMULA_RECOGNITION_REPOSITORY = "PaddlePaddle/PP-FormulaNet_plus-S"
FORMULA_RECOGNITION_MODEL_NAME = "PP-FormulaNet_plus-S"
FORMULA_RECOGNITION_DIRECTORY_NAME = "pp-formulanet-plus-s"
FORMULA_LAYOUT_REPOSITORY = "PaddlePaddle/PP-DocLayout_plus-L"
FORMULA_LAYOUT_MODEL_NAME = "PP-DocLayout_plus-L"
FORMULA_LAYOUT_DIRECTORY_NAME = "pp-doclayout-plus-l"
FORMULA_REQUIRED_FILES = ("inference.yml", "inference.pdiparams")


class FormulaModelState(BaseModel):
    name: str = "视频公式识别"
    description: str = "从关键帧提取向量、范数、分式和矩阵等结构化公式。"
    repositories: list[str] = Field(
        default_factory=lambda: [
            FORMULA_LAYOUT_REPOSITORY,
            FORMULA_RECOGNITION_REPOSITORY,
        ]
    )
    installation_status: ModelInstallationStatus
    download_job: ModelDownloadJob | None = None


def formula_model_resources(models_root_directory: Path) -> tuple[ModelResource, ...]:
    """公式识别必须同时具备区域定位和 LaTeX 识别，避免整帧推理产生乱码。"""
    root_directory = (models_root_directory / FORMULA_MODELS_DIRECTORY_NAME).resolve()
    return (
        ModelResource(
            repository=FORMULA_LAYOUT_REPOSITORY,
            directory=_model_directory(root_directory, FORMULA_LAYOUT_DIRECTORY_NAME),
        ),
        ModelResource(
            repository=FORMULA_RECOGNITION_REPOSITORY,
            directory=_model_directory(
                root_directory,
                FORMULA_RECOGNITION_DIRECTORY_NAME,
            ),
        ),
    )


def is_formula_recognition_installed(models_root_directory: Path) -> bool:
    return all(
        model_resource_is_installed(resource, FORMULA_REQUIRED_FILES)
        for resource in formula_model_resources(models_root_directory)
    )


def _model_directory(root_directory: Path, directory_name: str) -> Path:
    model_directory = (root_directory / directory_name).resolve()
    if not model_directory.is_relative_to(root_directory):
        raise ValueError("公式识别模型目录无效")
    return model_directory
