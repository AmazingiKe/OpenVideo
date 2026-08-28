import json
import os
from pathlib import Path

import pytest

from openvideo.core import page_settings
from openvideo.core.page_settings import (
    MarkersPageSettings,
    PageSettingsDocument,
    PageSettingsStore,
)


LIBRARY_ID = "library-01890f4c7a2b7cc298c4dc0c0c07398f"


def test_missing_settings_use_markers_defaults(tmp_path: Path):
    settings = PageSettingsStore(tmp_path, LIBRARY_ID).load_markers()

    assert settings == MarkersPageSettings()


def test_markers_settings_round_trip_and_use_versioned_document(tmp_path: Path):
    store = PageSettingsStore(tmp_path, LIBRARY_ID)
    expected = MarkersPageSettings(
        left_panel_size_percent=30,
        left_panel_collapsed=True,
        left_panel_tab="agent",
    )

    store.save_markers(expected)

    assert PageSettingsStore(tmp_path, LIBRARY_ID).load_markers() == expected
    document = json.loads(store.path.read_text(encoding="utf-8"))
    assert document == {"version": 5, "markers": expected.model_dump()}


def test_markers_settings_are_published_with_atomic_replace(
    tmp_path: Path,
    monkeypatch,
):
    calls: list[tuple[Path, Path]] = []
    real_replace = os.replace

    def record_replace(source: Path, destination: Path) -> None:
        calls.append((source, destination))
        real_replace(source, destination)

    monkeypatch.setattr(page_settings.os, "replace", record_replace)

    store = PageSettingsStore(tmp_path, LIBRARY_ID)
    store.save_markers(MarkersPageSettings())

    assert calls == [(store.path.with_name(f".{store.path.name}.tmp"), store.path)]
    assert not store.path.with_name(f".{store.path.name}.tmp").exists()


def test_corrupted_settings_fall_back_to_defaults(tmp_path: Path):
    store = PageSettingsStore(tmp_path, LIBRARY_ID)
    store.path.write_text("{not-json", encoding="utf-8")

    assert store.load_markers() == MarkersPageSettings()

    store.path.write_text(
        '{"version": 3, "markers": {"agent_panel_size_percent": 30}}',
        encoding="utf-8",
    )
    assert store.load_markers() == MarkersPageSettings()

    store.path.write_text(
        '{"version": 99, "markers": {}}',
        encoding="utf-8",
    )
    assert store.load_markers() == MarkersPageSettings()


def test_failed_atomic_publish_preserves_existing_settings(
    tmp_path: Path,
    monkeypatch,
):
    store = PageSettingsStore(tmp_path, LIBRARY_ID)
    existing = MarkersPageSettings(left_panel_size_percent=28)
    store.save_markers(existing)

    def fail_replace(source: Path, destination: Path) -> None:
        raise OSError(f"无法替换 {source} 到 {destination}")

    monkeypatch.setattr(page_settings.os, "replace", fail_replace)

    with pytest.raises(OSError):
        store.save_markers(MarkersPageSettings(left_panel_size_percent=30))

    assert store.load_markers() == existing
    assert not store.path.with_name(f".{store.path.name}.tmp").exists()


def test_library_page_settings_are_moved_to_central_directory(tmp_path: Path):
    library_path = tmp_path / "library"
    config_directory = tmp_path / "config"
    library_path.mkdir()
    legacy_path = library_path / "page_setting.json"
    legacy_path.write_text(
        PageSettingsDocument(
            markers=MarkersPageSettings(left_panel_size_percent=30)
        ).model_dump_json(),
        encoding="utf-8",
    )

    store = PageSettingsStore(config_directory, LIBRARY_ID, legacy_path)

    assert store.path.parent == config_directory
    assert store.path.is_file()
    assert store.load_markers().left_panel_size_percent == 30
    assert not legacy_path.exists()
