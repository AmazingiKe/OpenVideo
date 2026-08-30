"""使用随应用安装的本地模型读取关键帧文字。"""

from __future__ import annotations

import os
from collections.abc import Callable, Sequence
from pathlib import Path
from threading import RLock
from typing import Any, Protocol

from openvideo.core.formula_models import (
    FORMULA_LAYOUT_MODEL_NAME,
    FORMULA_LAYOUT_REPOSITORY,
    FORMULA_RECOGNITION_MODEL_NAME,
    FORMULA_RECOGNITION_REPOSITORY,
    formula_model_resources,
    is_formula_recognition_installed,
)


MINIMUM_TEXT_SCORE = 0.55
MAXIMUM_FORMULA_CHARACTERS = 4096
FORMULA_SYMBOLS = frozenset("=<>+-*/^_()[]{}|\\")


class OcrOutput(Protocol):
    txts: Sequence[str] | None
    scores: Sequence[float] | None


OcrEngine = Callable[[Path], OcrOutput]


class FormulaEngine(Protocol):
    def predict(self, input: str) -> Sequence[Any]: ...


class LocalOcrReader:
    """延迟加载画面模型，避免应用启动被本地推理运行时阻塞。"""

    def __init__(
        self,
        engine: OcrEngine | None = None,
        *,
        models_root_directory: Path | None = None,
        formula_engine: FormulaEngine | None = None,
    ) -> None:
        self._engine = engine
        self._models_root_directory = models_root_directory
        self._formula_engine = formula_engine
        self._lock = RLock()

    def read_frames(self, frame_paths: Sequence[Path]) -> str | None:
        lines: list[str] = []
        seen: set[str] = set()
        with self._lock:
            engine = self._engine or self._create_engine()
            self._engine = engine
            for frame_path in frame_paths:
                output = engine(frame_path)
                texts = output.txts or ()
                scores = output.scores or ()
                for text, score in zip(texts, scores, strict=True):
                    normalized = " ".join(text.split())
                    if (
                        normalized
                        and score >= MINIMUM_TEXT_SCORE
                        and normalized not in seen
                    ):
                        seen.add(normalized)
                        lines.append(normalized)
        return "\n".join(lines) or None

    def read_formulas(self, frame_paths: Sequence[Path]) -> list[str]:
        if self._formula_engine is None and not self._formula_models_are_ready():
            return []
        formulas: list[str] = []
        seen: set[str] = set()
        try:
            with self._lock:
                engine = self._formula_engine or self._create_formula_engine()
                self._formula_engine = engine
                for frame_path in frame_paths:
                    for result in engine.predict(str(frame_path)):
                        for formula in _result_formulas(result):
                            normalized = formula.strip()
                            if (
                                _is_formula(normalized)
                                and normalized not in seen
                            ):
                                seen.add(normalized)
                                formulas.append(normalized)
        except Exception:
            return []
        return formulas

    def _formula_models_are_ready(self) -> bool:
        return (
            self._models_root_directory is not None
            and is_formula_recognition_installed(self._models_root_directory)
        )

    @staticmethod
    def _create_engine() -> OcrEngine:
        from rapidocr import RapidOCR

        return RapidOCR()

    def _create_formula_engine(self) -> FormulaEngine:
        if self._models_root_directory is None:
            raise RuntimeError("公式识别模型目录未配置")
        resources = {
            resource.repository: resource
            for resource in formula_model_resources(self._models_root_directory)
        }
        os.environ.setdefault("FLAGS_use_mkldnn", "0")
        os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
        from paddleocr import FormulaRecognitionPipeline

        return FormulaRecognitionPipeline(
            layout_detection_model_name=FORMULA_LAYOUT_MODEL_NAME,
            layout_detection_model_dir=str(
                resources[FORMULA_LAYOUT_REPOSITORY].directory
            ),
            formula_recognition_model_name=FORMULA_RECOGNITION_MODEL_NAME,
            formula_recognition_model_dir=str(
                resources[FORMULA_RECOGNITION_REPOSITORY].directory
            ),
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_layout_detection=True,
            enable_mkldnn=False,
        )


def _result_formulas(result: Any) -> list[str]:
    value = getattr(result, "json", result)
    if callable(value):
        value = value()
    if not isinstance(value, dict):
        return []
    payload = value.get("res", value)
    if not isinstance(payload, dict):
        return []
    formula_results = payload.get("formula_res_list")
    if not isinstance(formula_results, list):
        return []
    return [
        formula
        for item in formula_results
        if isinstance(item, dict)
        and isinstance((formula := item.get("rec_formula")), str)
    ]


def _is_formula(value: str) -> bool:
    return (
        1 < len(value) <= MAXIMUM_FORMULA_CHARACTERS
        and any(character in FORMULA_SYMBOLS for character in value)
    )
