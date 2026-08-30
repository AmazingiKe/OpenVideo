from pathlib import Path
from types import SimpleNamespace

from openvideo.core.formula_models import formula_model_resources
from openvideo.tools.ocr import LocalOcrReader


def test_local_ocr_filters_low_confidence_and_deduplicates_frames(tmp_path: Path):
    frame_paths = [tmp_path / "first.jpg", tmp_path / "second.jpg"]
    outputs = iter(
        [
            SimpleNamespace(
                txts=("  透视   投影  ", "噪声"),
                scores=(0.99, 0.2),
            ),
            SimpleNamespace(
                txts=("透视 投影", "消失点"),
                scores=(0.98, 0.95),
            ),
        ]
    )
    reader = LocalOcrReader(lambda _frame_path: next(outputs))

    text = reader.read_frames(frame_paths)

    assert text == "透视 投影\n消失点"


def test_local_ocr_returns_none_when_frames_have_no_reliable_text(tmp_path: Path):
    reader = LocalOcrReader(
        lambda _frame_path: SimpleNamespace(txts=("噪声",), scores=(0.1,))
    )

    assert reader.read_frames([tmp_path / "frame.jpg"]) is None


def test_formula_reader_extracts_latex_and_deduplicates_frames(tmp_path: Path):
    class FormulaEngine:
        def predict(self, _input: str):
            return [
                SimpleNamespace(
                    json={
                        "res": {
                            "formula_res_list": [
                                {"rec_formula": r"\hat{a}=\vec{a}/\|\vec{a}\|"},
                                {"rec_formula": "ordinary words"},
                            ]
                        }
                    }
                )
            ]

    reader = LocalOcrReader(formula_engine=FormulaEngine())

    formulas = reader.read_formulas(
        [tmp_path / "first.jpg", tmp_path / "second.jpg"]
    )

    assert formulas == [r"\hat{a}=\vec{a}/\|\vec{a}\|"]


def test_formula_reader_keeps_plain_ocr_available_after_formula_failure(tmp_path: Path):
    class FailingFormulaEngine:
        def predict(self, _input: str):
            raise RuntimeError("公式运行时失败")

    reader = LocalOcrReader(
        lambda _frame_path: SimpleNamespace(txts=("投影矩阵",), scores=(0.99,)),
        formula_engine=FailingFormulaEngine(),
    )

    assert reader.read_formulas([tmp_path / "frame.jpg"]) == []
    assert reader.read_frames([tmp_path / "frame.jpg"]) == "投影矩阵"


def test_formula_reader_does_not_load_engine_before_models_are_installed(
    monkeypatch,
    tmp_path: Path,
):
    reader = LocalOcrReader(models_root_directory=tmp_path)
    monkeypatch.setattr(
        reader,
        "_create_formula_engine",
        lambda: (_ for _ in ()).throw(AssertionError("不应加载模型")),
    )

    assert reader.read_formulas([tmp_path / "frame.jpg"]) == []


def test_formula_resources_require_both_layout_and_recognition_models(tmp_path: Path):
    resources = formula_model_resources(tmp_path)

    assert {resource.repository for resource in resources} == {
        "PaddlePaddle/PP-DocLayout_plus-L",
        "PaddlePaddle/PP-FormulaNet_plus-S",
    }
    assert all(resource.directory.is_relative_to(tmp_path.resolve()) for resource in resources)
