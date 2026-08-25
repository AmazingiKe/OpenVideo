import json
from pathlib import Path

import pytest

from openvideo.core.library import FolderConflictError, MediaLibrary
from openvideo.core.media_models import MediaAsset, MediaAssetStatus, SourcePlatform


ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"


def save_asset(
    library: MediaLibrary,
    *,
    folder_id: str | None = None,
) -> MediaAsset:
    asset = MediaAsset(
        asset_id=ASSET_ID,
        folder_id=folder_id,
        source_url="https://example.com/video",
        source_platform=SourcePlatform.YOUTUBE,
        source_video_id="video",
        title="测试视频",
        status=MediaAssetStatus.READY,
        playback_path="media/playback.mp4",
    )
    media_directory = library.media_directory(asset.asset_id)
    (media_directory / "playback.mp4").write_bytes(b"video")
    library.save(asset)
    return asset


def test_folder_tree_enforces_names_cycles_and_updates_subtree_paths(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    courses = library.create_folder("课程")
    shots = library.create_folder("镜头", courses.folder_id)
    notes = library.create_folder("笔记", shots.folder_id)

    with pytest.raises(FolderConflictError, match="重名"):
        library.create_folder("课程")
    with pytest.raises(FolderConflictError, match="后代"):
        library.move_folder(courses.folder_id, notes.folder_id)

    moved = library.move_folder(shots.folder_id, None)
    moved_notes = library.get_folder(notes.folder_id)
    assert moved.parent_id is None
    assert moved.materialized_path == f"/{shots.folder_id}/"
    assert moved_notes.materialized_path == (f"/{shots.folder_id}/{notes.folder_id}/")
    library.close()


def test_folder_manifest_and_asset_assignment_rebuild_sqlite(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    courses = library.create_folder("课程")
    save_asset(library, folder_id=courses.folder_id)
    library.close()

    (tmp_path / "openvideo.sqlite3").unlink()
    rebuilt = MediaLibrary.open(tmp_path)

    folders = rebuilt.list_folders()
    assert folders[0].folder_id == courses.folder_id
    assert folders[0].direct_asset_count == 1
    assert folders[0].recursive_asset_count == 1
    assert rebuilt.get(ASSET_ID).folder_id == courses.folder_id
    rebuilt.close()


def test_old_asset_metadata_without_folder_is_uncategorized(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    save_asset(library)
    metadata_path = library.asset_directory(ASSET_ID) / "meta.json"
    library.close()

    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata.pop("folder_id", None)
    metadata_path.write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (tmp_path / "folders.json").unlink()
    (tmp_path / "openvideo.sqlite3").unlink()

    rebuilt = MediaLibrary.open(tmp_path)
    assert rebuilt.list_folders() == []
    assert [asset.asset_id for asset in rebuilt.list(uncategorized=True)] == [ASSET_ID]
    assert rebuilt.get(ASSET_ID).folder_id is None
    rebuilt.close()


def test_delete_asset_removes_complete_asset_directory(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    save_asset(library)
    asset_directory = library.asset_directory(ASSET_ID)
    (library.artifacts_directory(ASSET_ID) / "result.txt").write_text(
        "analysis",
        encoding="utf-8",
    )

    library.delete_asset(ASSET_ID)

    assert not asset_directory.exists()
    assert library.get(ASSET_ID) is None
    library.close()
