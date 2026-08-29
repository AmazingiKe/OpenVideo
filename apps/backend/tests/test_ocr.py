from pathlib import Path
from types import SimpleNamespace

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
