import json
from pathlib import Path

import pytest

from openvideo.core.library import InvalidLibraryError, LibraryLockedError, MediaLibrary


def test_creates_library_in_parent_with_uuid7_manifest(tmp_path: Path):
    library = MediaLibrary.create_in_parent(tmp_path, "课程")

    assert library.library_path.name == "课程.openvideo-library"
    manifest = json.loads((library.library_path / "library.json").read_text(encoding="utf-8"))
    assert manifest["library_id"].startswith("library-")
    assert len(manifest["library_id"]) == len("library-") + 32
    assert manifest["library_id"][len("library-") + 12] == "7"
    assert (library.library_path / "openvideo.sqlite3").is_file()
    assert all((library.library_path / name).is_dir() for name in ("assets", "cache", "temp"))
    library.close()


def test_initializing_non_empty_directory_is_rejected(tmp_path: Path):
    (tmp_path / "existing.txt").write_text("data", encoding="utf-8")
    with pytest.raises(InvalidLibraryError):
        MediaLibrary.initialize_directory(tmp_path)


def test_open_holds_an_exclusive_lock(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    with pytest.raises(LibraryLockedError):
        MediaLibrary.open(tmp_path)
    library.close()


def test_invalid_manifest_is_rejected(tmp_path: Path):
    (tmp_path / "library.json").write_text("{}", encoding="utf-8")
    with pytest.raises(InvalidLibraryError):
        MediaLibrary.open(tmp_path)
