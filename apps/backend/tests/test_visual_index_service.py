import asyncio
from pathlib import Path

from PIL import Image
import pytest

from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import (
    MediaAsset,
    MediaAssetStatus,
    MediaSegment,
    SourcePlatform,
)
from openvideo.settings import Settings
from openvideo.visual_index_service import VisualIndexService
from test_api_summary import create_client


ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"
SEGMENT_ID = "segment-01890f4c7a2b7cc298c4dc0c0c073994"


@pytest.mark.asyncio
async def test_visual_index_is_lazy_persistent_searchable_and_unloadable(
    tmp_path: Path,
):
    library = _create_library_with_frames(tmp_path)
    encoder = FakeVisualEncoder()
    service = VisualIndexService(
        library,
        Settings(library_path=tmp_path),
        encoder=encoder,
    )

    initial = service.status()

    assert initial.state == "not_prepared"
    assert initial.model_loaded is False
    assert encoder.prepare_count == 0

    service.prepare(ASSET_ID)
    await _wait_until_terminal(service)
    ready = service.status()
    matches = service.search(ASSET_ID, "编辑器界面", limit=2)

    assert ready.state == "ready"
    assert ready.indexed_frames == 2
    assert ready.model_loaded is True
    assert encoder.prepare_count == 1
    assert [match.relative_path for match in matches] == [
        "artifacts/frames/first.jpg",
        "artifacts/frames/second.jpg",
    ]
    assert (
        len(
            library.load_visual_frame_vectors(
                asset_id=ASSET_ID,
                model_name=encoder.model_name,
                model_revision=encoder.model_revision,
            )
        )
        == 2
    )

    unloaded = service.unload()

    assert unloaded.state == "ready"
    assert unloaded.model_loaded is False
    assert encoder.unload_count == 1
    library.close()


@pytest.mark.asyncio
async def test_visual_index_rejects_unknown_asset_without_loading(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    encoder = FakeVisualEncoder()
    service = VisualIndexService(
        library,
        Settings(library_path=tmp_path),
        encoder=encoder,
    )

    with pytest.raises(ValueError, match="视频素材不存在"):
        service.prepare("01890f4c-7a2b-7cc2-98c4-dc0c0c073991")

    assert encoder.prepare_count == 0
    library.close()


async def _wait_until_terminal(service: VisualIndexService) -> None:
    for _ in range(100):
        if service.status().state in {"ready", "error"}:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("视觉索引任务未完成")


def _create_library_with_frames(tmp_path: Path) -> MediaLibrary:
    library = MediaLibrary.initialize_directory(tmp_path)
    asset_directory = library.asset_directory(ASSET_ID)
    frames_directory = asset_directory / "artifacts" / "frames"
    frames_directory.mkdir(parents=True)
    first = frames_directory / "first.jpg"
    second = frames_directory / "second.jpg"
    Image.new("RGB", (64, 64), "navy").save(first)
    Image.new("RGB", (64, 64), "orange").save(second)
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url=str(tmp_path / "video.mp4"),
            source_platform=SourcePlatform.LOCAL,
            title="视觉索引测试",
            duration_seconds=20,
            status=MediaAssetStatus.READY,
        )
    )
    library.save_segments(
        ASSET_ID,
        [
            MediaSegment(
                segment_id=SEGMENT_ID,
                asset_id=ASSET_ID,
                start_seconds=0,
                end_seconds=20,
                key_frame_paths=[
                    "artifacts/frames/first.jpg",
                    "artifacts/frames/second.jpg",
                ],
            )
        ],
    )
    return library


class FakeVisualEncoder:
    model_name = "test/siglip2"
    model_revision = "test-revision"

    def __init__(self) -> None:
        self.loaded = False
        self.prepare_count = 0
        self.unload_count = 0

    def prepare(self) -> None:
        self.prepare_count += int(not self.loaded)
        self.loaded = True

    def encode_images(self, paths, report_progress):
        self.prepare()
        vectors = [[1.0, 0.0, 0.0], [0.8, 0.2, 0.0]][: len(paths)]
        report_progress(len(vectors), len(vectors))
        return vectors

    def encode_text(self, _query: str) -> list[float]:
        self.prepare()
        return [1.0, 0.0, 0.0]

    def unload(self) -> None:
        self.loaded = False
        self.unload_count += 1


def test_visual_index_status_endpoint_does_not_prepare_model(
    tmp_path: Path,
):
    with create_client(tmp_path) as client:
        response = client.get("/api/visual-index/status")

    assert response.status_code == 200
    assert response.json()["state"] == "not_prepared"
    assert response.json()["model_loaded"] is False
