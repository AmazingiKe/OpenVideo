import subprocess
from pathlib import Path

from openvideo.core.identifiers import is_prefixed_uuid7
from openvideo.core.thumbnails import ThumbnailStoryboardManifest
from openvideo.tools import thumbnails


def test_publishes_all_storyboard_pages_with_persistent_identifiers(
    monkeypatch,
    tmp_path: Path,
):
    def generate_pages(command: list[str], **_options):
        output_pattern = Path(command[-1])
        for page_number in range(1, 3):
            page_file = Path(str(output_pattern).replace("%04d", f"{page_number:04d}"))
            page_file.write_bytes(f"page-{page_number}".encode())
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(thumbnails, "resolve_tool", lambda *_arguments: "ffmpeg")
    monkeypatch.setattr(thumbnails.subprocess, "run", generate_pages)
    media_directory = tmp_path / "media"

    manifest_file = thumbnails.generate_thumbnail_storyboard(
        tmp_path / "video.mp4",
        media_directory,
        126,
        1920,
        1080,
        None,
        None,
    )

    assert manifest_file is not None
    manifest = ThumbnailStoryboardManifest.model_validate_json(
        manifest_file.read_text(encoding="utf-8")
    )
    assert is_prefixed_uuid7(manifest.storyboard_id, "storyboard-")
    assert [page.tile_count for page in manifest.pages] == [25, 1]
    assert all(
        is_prefixed_uuid7(page.page_id, "storyboard-page-") for page in manifest.pages
    )
    assert all(page.relative_path.startswith("media/") for page in manifest.pages)
    assert len(list(media_directory.glob("storyboard-page-*.jpg"))) == 2


def test_returns_unavailable_when_storyboard_generation_times_out(
    monkeypatch,
    tmp_path: Path,
):
    def time_out(_command: list[str], **_options):
        raise subprocess.TimeoutExpired("ffmpeg", 1)

    monkeypatch.setattr(thumbnails, "resolve_tool", lambda *_arguments: "ffmpeg")
    monkeypatch.setattr(thumbnails.subprocess, "run", time_out)

    assert (
        thumbnails.generate_thumbnail_storyboard(
            tmp_path / "video.mp4",
            tmp_path / "media",
            60,
            1920,
            1080,
            None,
            None,
        )
        is None
    )
