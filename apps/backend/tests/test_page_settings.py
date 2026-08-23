import json
import os
from pathlib import Path

import pytest

from openvideo.core import page_settings
from openvideo.core.page_settings import AnalysisPageSettings, PageSettingsStore


def test_missing_settings_use_analysis_defaults(tmp_path: Path):
    settings = PageSettingsStore(tmp_path).load_analysis()

    assert settings == AnalysisPageSettings()
    assert settings.open_tool_sections == ["video_information"]


def test_analysis_settings_round_trip_and_use_versioned_document(tmp_path: Path):
    store = PageSettingsStore(tmp_path)
    expected = AnalysisPageSettings(
        asset_library_size_percent=22,
        asset_library_collapsed=True,
        tool_panel_size_percent=24,
        tool_panel_collapsed=False,
        open_tool_sections=["transcription", "analysis"],
    )

    store.save_analysis(expected)

    assert PageSettingsStore(tmp_path).load_analysis() == expected
    document = json.loads((tmp_path / "page_setting.json").read_text(encoding="utf-8"))
    assert document == {"version": 1, "analysis": expected.model_dump()}


def test_analysis_settings_are_published_with_atomic_replace(
    tmp_path: Path,
    monkeypatch,
):
    calls: list[tuple[Path, Path]] = []
    real_replace = os.replace

    def record_replace(source: Path, destination: Path) -> None:
        calls.append((source, destination))
        real_replace(source, destination)

    monkeypatch.setattr(page_settings.os, "replace", record_replace)

    PageSettingsStore(tmp_path).save_analysis(AnalysisPageSettings())

    assert calls == [
        (tmp_path / ".page_setting.json.tmp", tmp_path / "page_setting.json")
    ]
    assert not (tmp_path / ".page_setting.json.tmp").exists()


def test_corrupted_settings_fall_back_to_defaults(tmp_path: Path):
    (tmp_path / "page_setting.json").write_text("{not-json", encoding="utf-8")

    assert PageSettingsStore(tmp_path).load_analysis() == AnalysisPageSettings()

    (tmp_path / "page_setting.json").write_text(
        '{"version": 99, "analysis": {}}',
        encoding="utf-8",
    )
    assert PageSettingsStore(tmp_path).load_analysis() == AnalysisPageSettings()


def test_failed_atomic_publish_preserves_existing_settings(
    tmp_path: Path,
    monkeypatch,
):
    store = PageSettingsStore(tmp_path)
    existing = AnalysisPageSettings(asset_library_size_percent=18)
    store.save_analysis(existing)

    def fail_replace(source: Path, destination: Path) -> None:
        raise OSError(f"无法替换 {source} 到 {destination}")

    monkeypatch.setattr(page_settings.os, "replace", fail_replace)

    with pytest.raises(OSError):
        store.save_analysis(
            AnalysisPageSettings(asset_library_size_percent=24)
        )

    assert store.load_analysis() == existing
    assert not (tmp_path / ".page_setting.json.tmp").exists()
