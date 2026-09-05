import asyncio
from array import array
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock

from PIL import Image
import pytest

from openvideo.core.library import MediaLibrary
from openvideo.core.identifiers import uuid7
from openvideo.core.media_models import (
    MediaAsset,
    MediaAssetStatus,
    MediaSegment,
    SourcePlatform,
)
from openvideo.settings import Settings
from openvideo import visual_index_service
from openvideo.visual_index_service import VisualEncoder, VisualIndexService
from test_api_summary import create_client


ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"
SECOND_ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c073990"
VISUAL_BUILD_WAIT_SECONDS = 5


@pytest.fixture
def visual_service(tmp_path: Path):
    library = _create_library_with_frames(tmp_path)
    encoder = FakeVisualEncoder()
    service = VisualIndexService(
        library, Settings(library_path=tmp_path), encoder=encoder
    )
    try:
        yield library, encoder, service
    finally:
        service.unload()
        library.close()


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
            library.load_visual_frame_embeddings(
                asset_id=ASSET_ID,
                model_name=encoder.model_name,
                model_revision=encoder.model_revision,
                dimensions=encoder.dimensions,
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


def test_visual_index_status_remains_responsive_during_inference(
    tmp_path: Path, monkeypatch
):
    library = _create_library_with_frames(tmp_path)
    encoder = VisualEncoder(tmp_path / "models")
    processor_factory = Mock()
    processor_factory.from_pretrained.return_value = lambda **_kwargs: {}
    torch_runtime = SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: False),
        device=lambda name: name,
        float32="float32",
    )
    monkeypatch.setattr(encoder, "_ensure_installed", lambda: None)
    monkeypatch.setattr(
        "openvideo.visual_index_service._transformer_runtime",
        lambda: (torch_runtime, Mock(), processor_factory),
    )
    encoder.prepare()
    entered_inference = Event()
    finish_inference = Event()

    def encode_features(_inputs):
        entered_inference.set()
        assert finish_inference.wait(timeout=5)
        return [[1.0, 0.0]]

    monkeypatch.setattr(encoder, "_image_features", encode_features)
    service = VisualIndexService(
        library, Settings(library_path=tmp_path), encoder=encoder
    )
    image_path = library.asset_directory(ASSET_ID) / "artifacts/frames/first.jpg"
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            inference = executor.submit(
                encoder.encode_images, [image_path], lambda *_args: None
            )
            try:
                assert entered_inference.wait(timeout=5)
                status = executor.submit(service.status).result(timeout=1)
                assert status.model_loaded is True
            finally:
                finish_inference.set()
            assert inference.result(timeout=5) == [[1.0, 0.0]]
    finally:
        library.close()


@pytest.mark.asyncio
async def test_visual_index_reuses_unchanged_and_renamed_content_without_loading(
    visual_service,
):
    library, encoder, service = visual_service
    assert await service.ensure_ready(ASSET_ID)
    asset_directory = library.asset_directory(ASSET_ID)
    first_path = asset_directory / "artifacts/frames/first.jpg"
    renamed_path = first_path.with_name("renamed.jpg")
    first_path.rename(renamed_path)
    second_path = asset_directory / "artifacts/frames/second.jpg"
    os.utime(second_path, None)
    _set_frame_paths(
        library,
        ASSET_ID,
        ["artifacts/frames/renamed.jpg", "artifacts/frames/second.jpg"],
    )
    service.unload()

    assert await service.ensure_ready(ASSET_ID)

    assert encoder.prepare_count == 1
    assert encoder.loaded is False
    assert [len(batch) for batch in encoder.encoded_batches] == [2]
    assert service.is_ready(ASSET_ID)
    cached_paths = {
        row[0]
        for row in library._db().execute(
            "SELECT relative_path FROM visual_frame_embeddings WHERE asset_id = ?",
            (ASSET_ID,),
        )
    }
    assert cached_paths == {
        "artifacts/frames/renamed.jpg",
        "artifacts/frames/second.jpg",
    }


@pytest.mark.asyncio
async def test_visual_index_only_encodes_added_and_changed_frame_bytes(visual_service):
    library, encoder, service = visual_service
    assert await service.ensure_ready(ASSET_ID)
    asset_directory = library.asset_directory(ASSET_ID)
    first_path = asset_directory / "artifacts/frames/first.jpg"
    original_stat = first_path.stat()
    replacement = first_path.read_bytes().replace(b"JFIF", b"JFIQ", 1)
    first_path.write_bytes(replacement)
    os.utime(first_path, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
    added_path = first_path.with_name("added.jpg")
    Image.new("RGB", (64, 64), "green").save(added_path)
    _set_frame_paths(
        library,
        ASSET_ID,
        [
            "artifacts/frames/first.jpg",
            "artifacts/frames/second.jpg",
            "artifacts/frames/added.jpg",
        ],
    )

    assert await service.ensure_ready(ASSET_ID)

    assert [path.name for path in encoder.encoded_batches[-1]] == [
        "first.jpg",
        "added.jpg",
    ]
    assert [len(batch) for batch in encoder.encoded_batches] == [2, 2]
    assert service.status().indexed_frames == 3
    assert service.is_ready(ASSET_ID)


@pytest.mark.asyncio
async def test_visual_index_deduplicates_identical_frame_content(visual_service):
    library, encoder, service = visual_service
    asset_directory = library.asset_directory(ASSET_ID)
    first_path = asset_directory / "artifacts/frames/first.jpg"
    duplicate_path = first_path.with_name("duplicate.jpg")
    duplicate_path.write_bytes(first_path.read_bytes())
    _set_frame_paths(
        library,
        ASSET_ID,
        [
            "artifacts/frames/first.jpg",
            "artifacts/frames/duplicate.jpg",
            "artifacts/frames/first.jpg",
        ],
    )

    assert await service.ensure_ready(ASSET_ID)

    assert [len(batch) for batch in encoder.encoded_batches] == [1]
    assert service.status().indexed_frames == 2
    assert service.is_ready(ASSET_ID)


@pytest.mark.asyncio
async def test_visual_index_ready_does_not_hide_a_new_asset(visual_service):
    library, encoder, service = visual_service
    assert await service.ensure_ready(ASSET_ID)
    _save_asset_with_frames(library, SECOND_ASSET_ID)

    assert not service.is_ready(SECOND_ASSET_ID)
    assert service.search(SECOND_ASSET_ID, "画面") == []
    assert await service.ensure_ready(SECOND_ASSET_ID)

    assert [len(batch) for batch in encoder.encoded_batches] == [2, 2]
    assert service.is_ready(ASSET_ID)
    assert service.is_ready(SECOND_ASSET_ID)
    assert len(service.search(SECOND_ASSET_ID, "画面")) == 2


@pytest.mark.asyncio
async def test_empty_visual_search_never_reloads_cached_model(visual_service):
    _library, encoder, service = visual_service
    assert await service.ensure_ready(ASSET_ID)
    service.unload()

    assert service.search(ASSET_ID, "   ") == []
    assert service.search(ASSET_ID, "画面", limit=0) == []
    assert service.search(ASSET_ID, "画面", limit=-1) == []
    assert not encoder.loaded
    assert encoder.prepare_count == 1


@pytest.mark.asyncio
async def test_visual_index_removes_deleted_frames_without_encoding(visual_service):
    library, encoder, service = visual_service
    assert await service.ensure_ready(ASSET_ID)
    service.unload()
    _set_frame_paths(library, ASSET_ID, ["artifacts/frames/second.jpg"])

    assert [item.relative_path for item in service.search(ASSET_ID, "画面")] == [
        "artifacts/frames/second.jpg"
    ]
    service.unload()
    prepare_count = encoder.prepare_count
    assert await service.ensure_ready(ASSET_ID)
    assert service.status().indexed_frames == 1
    _set_frame_paths(library, ASSET_ID, [])

    assert not await service.ensure_ready(ASSET_ID)
    assert service.status().indexed_frames == 0
    assert encoder.prepare_count == prepare_count
    assert [len(batch) for batch in encoder.encoded_batches] == [2]
    assert (
        library._db()
        .execute("SELECT COUNT(*) FROM visual_frame_embeddings")
        .fetchone()[0]
        == 0
    )


@pytest.mark.asyncio
async def test_visual_index_without_frames_does_not_prepare_model(visual_service):
    library, encoder, service = visual_service
    _set_frame_paths(library, ASSET_ID, [])

    assert not await service.ensure_ready(ASSET_ID)

    assert service.status().state == "ready"
    assert service.status().indexed_frames == 0
    assert encoder.prepare_count == 0
    assert encoder.encoded_batches == []


@pytest.mark.asyncio
async def test_visual_index_model_revision_change_recomputes_all_frames(visual_service):
    _library, encoder, service = visual_service
    assert await service.ensure_ready(ASSET_ID)
    encoder.model_revision = "next-revision"

    assert service.status().state == "not_prepared"
    assert not service.is_ready(ASSET_ID)
    assert await service.ensure_ready(ASSET_ID)

    assert [len(batch) for batch in encoder.encoded_batches] == [2, 2]
    assert service.status().model_revision == "next-revision"


@pytest.mark.asyncio
async def test_visual_index_failed_update_preserves_cache_and_can_retry(
    visual_service, monkeypatch
):
    library, encoder, service = visual_service
    assert await service.ensure_ready(ASSET_ID)
    previous_rows = list(library._db().execute("SELECT * FROM visual_frame_embeddings"))
    first_path = library.asset_directory(ASSET_ID) / "artifacts/frames/first.jpg"
    Image.new("RGB", (64, 64), "green").save(first_path)
    encode_images = encoder.encode_images

    def failed_encoding(_paths, _report):
        raise RuntimeError("测试模型暂不可用")

    monkeypatch.setattr(encoder, "encode_images", failed_encoding)
    assert not await service.ensure_ready(ASSET_ID)
    assert service.status().state == "error"
    assert (
        list(library._db().execute("SELECT * FROM visual_frame_embeddings"))
        == previous_rows
    )
    assert [item.relative_path for item in service.search(ASSET_ID, "画面")] == [
        "artifacts/frames/second.jpg"
    ]
    monkeypatch.setattr(encoder, "encode_images", encode_images)

    assert await service.ensure_ready(ASSET_ID)
    assert [len(batch) for batch in encoder.encoded_batches] == [2, 1]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "invalid_vector",
    [b"bad", array("f", [float("nan")] * 3).tobytes(), array("f", [1.0]).tobytes()],
)
async def test_visual_index_recomputes_only_invalid_cached_vectors(
    visual_service, invalid_vector
):
    library, encoder, service = visual_service
    assert await service.ensure_ready(ASSET_ID)
    with library._db():
        library._db().execute(
            "UPDATE visual_frame_embeddings SET vector = ? WHERE relative_path = ?",
            (invalid_vector, "artifacts/frames/first.jpg"),
        )

    assert not service.is_ready(ASSET_ID)
    assert await service.ensure_ready(ASSET_ID)

    assert [len(batch) for batch in encoder.encoded_batches] == [2, 1]
    assert service.is_ready(ASSET_ID)


@pytest.mark.asyncio
async def test_visual_index_uses_source_frame_timestamp(visual_service):
    library, _encoder, service = visual_service
    frame_path = (
        library.asset_directory(ASSET_ID) / "artifacts/frames/frame_000_12.3s.jpg"
    )
    Image.new("RGB", (64, 64), "green").save(frame_path)
    _set_frame_paths(library, ASSET_ID, ["artifacts/frames/frame_000_12.3s.jpg"])

    assert await service.ensure_ready(ASSET_ID)

    assert service.search(ASSET_ID, "画面")[0].seconds == 12.3


@pytest.mark.asyncio
async def test_visual_index_queues_a_second_asset_during_inference(
    visual_service, monkeypatch
):
    library, encoder, service = visual_service
    _save_asset_with_frames(library, SECOND_ASSET_ID)
    started = Event()
    release = Event()
    encode_images = encoder.encode_images

    def blocked_encoding(paths, report):
        started.set()
        assert release.wait(VISUAL_BUILD_WAIT_SECONDS)
        return encode_images(paths, report)

    monkeypatch.setattr(encoder, "encode_images", blocked_encoding)
    first = asyncio.create_task(service.ensure_ready(ASSET_ID))
    try:
        assert await asyncio.to_thread(started.wait, VISUAL_BUILD_WAIT_SECONDS)
        second = asyncio.create_task(service.ensure_ready(SECOND_ASSET_ID))
        await asyncio.sleep(0)
        release.set()
        assert await first
        assert await second
    finally:
        release.set()

    assert [len(batch) for batch in encoder.encoded_batches] == [2, 2]
    assert service.is_ready(ASSET_ID)
    assert service.is_ready(SECOND_ASSET_ID)
    assert service.status().indexed_frames == 4


@pytest.mark.asyncio
async def test_visual_index_consumer_cancellation_keeps_shared_build_running(
    visual_service, monkeypatch
):
    _library, encoder, service = visual_service
    started = Event()
    release = Event()
    encode_images = encoder.encode_images

    def blocked_encoding(paths, report):
        started.set()
        assert release.wait(VISUAL_BUILD_WAIT_SECONDS)
        return encode_images(paths, report)

    monkeypatch.setattr(encoder, "encode_images", blocked_encoding)
    consumer = asyncio.create_task(service.ensure_ready(ASSET_ID))
    try:
        assert await asyncio.to_thread(started.wait, VISUAL_BUILD_WAIT_SECONDS)
        consumer.cancel()
        with pytest.raises(asyncio.CancelledError):
            await consumer
        assert service._task is not None
        assert not service._task.done()
        release.set()
        await asyncio.wait_for(asyncio.shield(service._task), VISUAL_BUILD_WAIT_SECONDS)
    finally:
        release.set()

    assert service.is_ready(ASSET_ID)
    assert [len(batch) for batch in encoder.encoded_batches] == [2]


@pytest.mark.asyncio
async def test_ready_asset_does_not_wait_for_another_assets_slow_build(
    visual_service, monkeypatch
):
    library, encoder, service = visual_service
    _save_asset_with_frames(library, SECOND_ASSET_ID)
    second_started = Event()
    release_second = Event()
    encode_images = encoder.encode_images

    def block_second_asset(paths, report):
        if library.asset_directory(SECOND_ASSET_ID) in paths[0].parents:
            second_started.set()
            assert release_second.wait(VISUAL_BUILD_WAIT_SECONDS)
        return encode_images(paths, report)

    monkeypatch.setattr(encoder, "encode_images", block_second_asset)
    first = asyncio.create_task(service.ensure_ready(ASSET_ID))
    second = asyncio.create_task(service.ensure_ready(SECOND_ASSET_ID))
    try:
        assert await asyncio.to_thread(second_started.wait, VISUAL_BUILD_WAIT_SECONDS)
        assert await asyncio.wait_for(first, 1)
        assert not second.done()
        assert service.search(ASSET_ID, "画面")
    finally:
        release_second.set()
        await asyncio.gather(first, second)

    assert second.result()


@pytest.mark.asyncio
async def test_visual_index_discards_results_when_source_changes_during_encoding(
    visual_service, monkeypatch
):
    library, encoder, service = visual_service
    assert await service.ensure_ready(ASSET_ID)
    previous_rows = list(library._db().execute("SELECT * FROM visual_frame_embeddings"))
    first_path = library.asset_directory(ASSET_ID) / "artifacts/frames/first.jpg"
    Image.new("RGB", (64, 64), "green").save(first_path)
    encode_images = encoder.encode_images

    def mutate_encoded_frame(paths, report):
        result = encode_images(paths, report)
        Image.new("RGB", (64, 64), "red").save(first_path)
        return result

    monkeypatch.setattr(encoder, "encode_images", mutate_encoded_frame)
    assert not await service.ensure_ready(ASSET_ID)

    assert "关键帧在索引期间发生变化" in service.status().error_message
    assert (
        list(library._db().execute("SELECT * FROM visual_frame_embeddings"))
        == previous_rows
    )
    monkeypatch.setattr(encoder, "encode_images", encode_images)
    assert await service.ensure_ready(ASSET_ID)
    assert [len(batch) for batch in encoder.encoded_batches] == [2, 1, 1]


@pytest.mark.asyncio
async def test_visual_index_does_not_recreate_deleted_asset_during_encoding(
    visual_service, monkeypatch
):
    library, encoder, service = visual_service
    started = Event()
    release = Event()
    encode_images = encoder.encode_images

    def blocked_encoding(paths, report):
        vectors = encode_images(paths, report)
        started.set()
        assert release.wait(VISUAL_BUILD_WAIT_SECONDS)
        return vectors

    monkeypatch.setattr(encoder, "encode_images", blocked_encoding)
    consumer = asyncio.create_task(service.ensure_ready(ASSET_ID))
    try:
        assert await asyncio.to_thread(started.wait, VISUAL_BUILD_WAIT_SECONDS)
        library.delete_asset(ASSET_ID)
        release.set()
        assert not await consumer
    finally:
        release.set()

    assert service.status().indexed_frames == 0
    assert service.search(ASSET_ID, "画面") == []
    assert (
        library._db()
        .execute("SELECT COUNT(*) FROM visual_frame_embeddings")
        .fetchone()[0]
        == 0
    )


@pytest.mark.asyncio
async def test_visual_index_search_reuses_hashes_and_rechecks_changed_files(
    visual_service, monkeypatch
):
    library, _encoder, service = visual_service
    assert await service.ensure_ready(ASSET_ID)
    hashed_paths = []
    sha256 = visual_index_service._sha256

    def count_hashes(path):
        hashed_paths.append(path)
        return sha256(path)

    monkeypatch.setattr(visual_index_service, "_sha256", count_hashes)
    assert len(service.search(ASSET_ID, "画面")) == 2
    assert len(service.search(ASSET_ID, "另外一个问题")) == 2
    assert hashed_paths == []
    first_path = library.asset_directory(ASSET_ID) / "artifacts/frames/first.jpg"
    Image.new("RGB", (64, 64), "green").save(first_path)

    assert len(service.search(ASSET_ID, "画面")) == 1
    assert len(service.search(ASSET_ID, "画面")) == 1
    assert hashed_paths == [first_path]


@pytest.mark.asyncio
async def test_visual_index_reopens_cached_asset_without_preparing_model(
    visual_service, monkeypatch
):
    library, _encoder, service = visual_service
    assert await service.ensure_ready(ASSET_ID)
    service.unload()
    reopened_encoder = FakeVisualEncoder()
    reopened_service = VisualIndexService(
        library, service.settings, encoder=reopened_encoder
    )

    def unexpected_preparation():
        raise AssertionError("已有有效向量时不应下载或加载模型")

    monkeypatch.setattr(reopened_encoder, "prepare", unexpected_preparation)

    assert await reopened_service.ensure_ready(ASSET_ID)
    assert reopened_service.status().model_loaded is False
    assert reopened_encoder.encoded_batches == []


@pytest.mark.asyncio
async def test_visual_index_database_failure_rolls_back_entire_asset(
    visual_service,
):
    library, encoder, service = visual_service
    assert await service.ensure_ready(ASSET_ID)
    previous_rows = list(library._db().execute("SELECT * FROM visual_frame_embeddings"))
    first_path = library.asset_directory(ASSET_ID) / "artifacts/frames/first.jpg"
    Image.new("RGB", (64, 64), "green").save(first_path)
    with library._db():
        library._db().execute(
            "CREATE TRIGGER reject_visual_frame_insert BEFORE INSERT "
            "ON visual_frame_embeddings BEGIN SELECT RAISE(ABORT, '模拟提交失败'); END"
        )

    assert not await service.ensure_ready(ASSET_ID)
    assert (
        list(library._db().execute("SELECT * FROM visual_frame_embeddings"))
        == previous_rows
    )
    with library._db():
        library._db().execute("DROP TRIGGER reject_visual_frame_insert")

    assert await service.ensure_ready(ASSET_ID)
    assert [len(batch) for batch in encoder.encoded_batches] == [2, 1, 1]


async def _wait_until_terminal(service: VisualIndexService) -> None:
    for _ in range(100):
        if service.status().state in {"ready", "error"}:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("视觉索引任务未完成")


def _create_library_with_frames(tmp_path: Path) -> MediaLibrary:
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset_with_frames(library, ASSET_ID)
    return library


def _save_asset_with_frames(library: MediaLibrary, asset_id: str) -> None:
    asset_directory = library.asset_directory(asset_id)
    frames_directory = asset_directory / "artifacts" / "frames"
    frames_directory.mkdir(parents=True)
    first = frames_directory / "first.jpg"
    second = frames_directory / "second.jpg"
    Image.new("RGB", (64, 64), "navy").save(first)
    Image.new("RGB", (64, 64), "orange").save(second)
    library.save(
        MediaAsset(
            asset_id=asset_id,
            source_url=str(asset_directory / "video.mp4"),
            source_platform=SourcePlatform.LOCAL,
            title="视觉索引测试",
            duration_seconds=20,
            status=MediaAssetStatus.READY,
        )
    )
    library.save_segments(
        asset_id,
        [
            MediaSegment(
                segment_id=f"segment-{uuid7().hex}",
                asset_id=asset_id,
                start_seconds=0,
                end_seconds=20,
                key_frame_paths=[
                    "artifacts/frames/first.jpg",
                    "artifacts/frames/second.jpg",
                ],
            )
        ],
    )


def _set_frame_paths(library: MediaLibrary, asset_id: str, paths: list[str]) -> None:
    segments = library.load_segments(asset_id)
    library.save_segments(
        asset_id,
        [segments[0].model_copy(update={"key_frame_paths": paths})],
    )


class FakeVisualEncoder:
    model_name = "test/siglip2"
    model_revision = "test-revision"
    dimensions = 3

    def __init__(self) -> None:
        self.loaded = False
        self.prepare_count = 0
        self.unload_count = 0
        self.encoded_batches: list[list[Path]] = []

    def prepare(self) -> None:
        self.prepare_count += int(not self.loaded)
        self.loaded = True

    def encode_images(self, paths, report_progress):
        self.prepare()
        self.encoded_batches.append(list(paths))
        vectors = []
        for path in paths:
            with Image.open(path) as image:
                red, green, blue = image.convert("RGB").getpixel((0, 0))
            vector = [blue + 1.0, float(red), float(green)]
            magnitude = sum(component * component for component in vector) ** 0.5
            vectors.append([component / magnitude for component in vector])
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
