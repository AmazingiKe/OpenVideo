"""使用随应用安装的本地模型读取关键帧文字。"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from pathlib import Path
from threading import RLock
from typing import Protocol


MINIMUM_TEXT_SCORE = 0.55


class OcrOutput(Protocol):
    txts: Sequence[str] | None
    scores: Sequence[float] | None


OcrEngine = Callable[[Path], OcrOutput]


class LocalOcrReader:
    """延迟加载 PP-OCRv6，避免应用启动被本地推理运行时阻塞。"""

    def __init__(self, engine: OcrEngine | None = None) -> None:
        self._engine = engine
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

    @staticmethod
    def _create_engine() -> OcrEngine:
        from rapidocr import RapidOCR

        return RapidOCR()
