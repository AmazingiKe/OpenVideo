from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from pydantic import TypeAdapter

from openvideo.core.summary_models import SummaryPreset


SUMMARY_PRESETS_PATH = Path(__file__).resolve().parents[1] / "summary_presets.json"


@lru_cache(maxsize=1)
def summary_presets() -> tuple[SummaryPreset, ...]:
    """内置角色作为只读产品契约加载，避免运行时会话修改生成策略。"""

    values = json.loads(SUMMARY_PRESETS_PATH.read_text(encoding="utf-8"))
    presets = TypeAdapter(list[SummaryPreset]).validate_python(values)
    preset_ids = [preset.preset_id for preset in presets]
    if len(preset_ids) != len(set(preset_ids)):
        raise ValueError("总结角色预设标识不能重复")
    return tuple(presets)


def require_summary_preset(preset_id: str) -> SummaryPreset:
    preset = next(
        (item for item in summary_presets() if item.preset_id == preset_id),
        None,
    )
    if preset is None:
        raise ValueError("总结角色预设不存在")
    return preset.model_copy(deep=True)
