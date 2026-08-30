"""视频画面公式识别所需的受管模型资源。"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


FORMULA_MODELS_DIRECTORY_NAME = "formula-recognition"
FORMULA_RECOGNITION_REPOSITORY = "PaddlePaddle/PP-FormulaNet_plus-S"
FORMULA_RECOGNITION_MODEL_NAME = "PP-FormulaNet_plus-S"
FORMULA_RECOGNITION_DIRECTORY_NAME = "pp-formulanet-plus-s"
FORMULA_LAYOUT_REPOSITORY = "PaddlePaddle/PP-DocLayout_plus-L"
FORMULA_LAYOUT_MODEL_NAME = "PP-DocLayout_plus-L"
FORMULA_LAYOUT_DIRECTORY_NAME = "pp-doclayout-plus-l"
FORMULA_REQUIRED_FILES = ("inference.yml", "inference.pdiparams")


@dataclass(frozen=True)
class FormulaModelResource:
    """一个可独立校验和恢复下载的公式识别模型仓库。"""

    repository: str
    directory: Path


def formula_model_resources(models_root_directory: Path) -> tuple[FormulaModelResource, ...]:
    """公式识别必须同时具备区域定位和 LaTeX 识别，避免整帧推理产生乱码。"""
    root_directory = (models_root_directory / FORMULA_MODELS_DIRECTORY_NAME).resolve()
    return (
        FormulaModelResource(
            repository=FORMULA_LAYOUT_REPOSITORY,
            directory=_model_directory(root_directory, FORMULA_LAYOUT_DIRECTORY_NAME),
        ),
        FormulaModelResource(
            repository=FORMULA_RECOGNITION_REPOSITORY,
            directory=_model_directory(
                root_directory,
                FORMULA_RECOGNITION_DIRECTORY_NAME,
            ),
        ),
    )


def is_formula_recognition_installed(models_root_directory: Path) -> bool:
    return all(
        all((resource.directory / filename).is_file() for filename in FORMULA_REQUIRED_FILES)
        for resource in formula_model_resources(models_root_directory)
    )


def _model_directory(root_directory: Path, directory_name: str) -> Path:
    model_directory = (root_directory / directory_name).resolve()
    if not model_directory.is_relative_to(root_directory):
        raise ValueError("公式识别模型目录无效")
    return model_directory
