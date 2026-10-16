import json
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from threading import Barrier

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.library_files import (
    ASSET_METADATA_FILE_NAME,
    VIDEO_CONFIGURATION_FILE_NAME,
)
from openvideo.core.library_index import DATABASE_FILE_NAME
from openvideo.core.media_models import (
    MediaAsset,
    MediaAssetStatus,
    MediaType,
    SourcePlatform,
)
from openvideo.core.transcription_models import Transcript, TranscriptSegment
from openvideo.settings import Settings
from openvideo.ui.media_routes import register_media_routes


ASSET_ID = str(uuid7())
PLAYBACK_URL = f"/api/media/assets/{ASSET_ID}/playback"
RECENT_URL = "/api/media/recent"


def save_playable_asset(
    library: MediaLibrary, asset_id: str, title: str = "课程"
) -> None:
    library.save(
        MediaAsset(
            asset_id=asset_id,
            title=title,
            source_url=f"local://{asset_id}",
            source_platform=SourcePlatform.LOCAL,
            status=MediaAssetStatus.READY,
            duration_seconds=100,
            playback_path="playback.mp4",
        )
    )
    (library.asset_directory(asset_id) / "playback.mp4").write_bytes(b"video")


def playback_client(library: MediaLibrary) -> TestClient:
    app = FastAPI()
    register_media_routes(app, lambda: library, Settings())
    return TestClient(app)


@pytest.fixture
def playback_library(tmp_path: Path) -> Iterator[tuple[TestClient, MediaLibrary]]:
    library = MediaLibrary.initialize_directory(tmp_path)
    save_playable_asset(library, ASSET_ID)
    with playback_client(library) as client:
        yield client, library
    library.close()


def playback_payload(library: MediaLibrary, **updates) -> dict:
    return {
        "library_id": library.manifest.library_id,
        "position_seconds": 30.5,
        "playback_rate": 1.5,
        **updates,
    }


def test_defaults_and_first_playback_are_saved_with_library_identity(playback_library):
    client, library = playback_library
    initial = client.get(PLAYBACK_URL)
    assert initial.status_code == 200
    assert initial.json() == {
        "position_seconds": 0,
        "playback_rate": 1,
        "last_watched_at": None,
        "observed_at": None,
        "library_id": library.manifest.library_id,
    }
    assert client.get(RECENT_URL).json() == []

    saved = client.patch(PLAYBACK_URL, json=playback_payload(library))
    assert saved.status_code == 200
    assert saved.json()["position_seconds"] == 30.5
    assert saved.json()["playback_rate"] == 1.5
    assert saved.json()["library_id"] == library.manifest.library_id
    assert saved.json()["observed_at"] == saved.json()["last_watched_at"]
    watched_at = datetime.fromisoformat(saved.json()["last_watched_at"])
    assert watched_at.utcoffset().total_seconds() == 0
    assert client.get(PLAYBACK_URL).json() == saved.json()

    asset_response = library.response_for(library.get(ASSET_ID)).model_dump(mode="json")
    assert asset_response["playback"] == {
        key: value for key, value in saved.json().items() if key != "library_id"
    }
    configuration_path = (
        library.asset_directory(ASSET_ID) / VIDEO_CONFIGURATION_FILE_NAME
    )
    configuration = json.loads(configuration_path.read_text(encoding="utf-8"))
    assert configuration["playback"] == asset_response["playback"]


@pytest.mark.parametrize(
    "updates",
    [
        {"position_seconds": -0.01},
        {"position_seconds": "NaN"},
        {"position_seconds": "Infinity"},
        {"playback_rate": 0},
        {"playback_rate": 0.24},
        {"playback_rate": 4.01},
        {"playback_rate": "NaN"},
        {"playback_rate": "Infinity"},
    ],
)
def test_playback_rejects_invalid_numbers_without_persisting(playback_library, updates):
    client, library = playback_library
    response = client.patch(PLAYBACK_URL, json=playback_payload(library, **updates))
    assert response.status_code == 422
    assert client.get(PLAYBACK_URL).json()["last_watched_at"] is None
    assert client.get(RECENT_URL).json() == []


@pytest.mark.parametrize("field", ["position_seconds", "playback_rate", "observed_at"])
@pytest.mark.parametrize("nonfinite", [float("nan"), float("inf"), float("-inf")])
def test_raw_nonfinite_json_returns_422_without_creating_configuration(
    playback_library, field: str, nonfinite: float
):
    client, library = playback_library
    payload = playback_payload(library, **{field: nonfinite})
    response = client.patch(
        PLAYBACK_URL,
        content=json.dumps(payload),
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 422
    configuration_path = (
        library.asset_directory(ASSET_ID) / VIDEO_CONFIGURATION_FILE_NAME
    )
    assert not configuration_path.exists()
    assert client.get(PLAYBACK_URL).json()["last_watched_at"] is None
    assert client.get(RECENT_URL).json() == []


@pytest.mark.parametrize(
    "missing_field", ["library_id", "position_seconds", "playback_rate"]
)
def test_playback_requires_all_request_fields(playback_library, missing_field: str):
    client, library = playback_library
    payload = playback_payload(library)
    payload.pop(missing_field)
    assert client.patch(PLAYBACK_URL, json=payload).status_code == 422


@pytest.mark.parametrize("playback_rate", [0.25, 4])
def test_playback_accepts_rate_bounds_clamps_position_and_saves_reset(
    playback_library, playback_rate: float
):
    client, library = playback_library
    clamped = client.patch(
        PLAYBACK_URL,
        json=playback_payload(
            library, position_seconds=1000, playback_rate=playback_rate
        ),
    )
    assert clamped.status_code == 200
    assert clamped.json()["position_seconds"] == 100
    assert clamped.json()["playback_rate"] == playback_rate
    reset = client.patch(
        PLAYBACK_URL,
        json=playback_payload(library, position_seconds=0, playback_rate=playback_rate),
    )
    assert reset.status_code == 200
    assert reset.json()["position_seconds"] == 0
    assert reset.json()["last_watched_at"] is not None


def test_playback_accepts_unknown_duration_without_artificial_limit(playback_library):
    client, library = playback_library
    asset = library.get(ASSET_ID)
    asset.duration_seconds = None
    library.save(asset)
    saved = client.patch(
        PLAYBACK_URL, json=playback_payload(library, position_seconds=1000)
    )
    assert saved.status_code == 200
    assert saved.json()["position_seconds"] == 1000


@pytest.mark.parametrize("method", ["get", "patch"])
def test_playback_requires_existing_ready_playable_video(playback_library, method: str):
    client, library = playback_library

    def request() -> object:
        if method == "get":
            return client.get(PLAYBACK_URL)
        return client.patch(PLAYBACK_URL, json=playback_payload(library))

    asset = library.get(ASSET_ID)
    asset.media_type = MediaType.IMAGE
    library.save(asset)
    assert request().status_code == 422

    asset.media_type = MediaType.VIDEO
    asset.status = MediaAssetStatus.PENDING
    library.save(asset)
    assert request().status_code in {404, 409}

    asset.status = MediaAssetStatus.READY
    library.save(asset)
    (library.asset_directory(ASSET_ID) / "playback.mp4").unlink()
    assert request().status_code == 404

    library.delete_asset(ASSET_ID)
    assert request().status_code == 404


def test_switching_libraries_rejects_a_delayed_save_for_the_same_asset_id(
    tmp_path: Path,
):
    first_path = tmp_path / "first"
    second_path = tmp_path / "second"
    first_path.mkdir()
    second_path.mkdir()
    first_library = MediaLibrary.initialize_directory(first_path)
    second_library = MediaLibrary.initialize_directory(second_path)
    save_playable_asset(first_library, ASSET_ID)
    save_playable_asset(second_library, ASSET_ID)
    active_library = [first_library]
    app = FastAPI()
    register_media_routes(app, lambda: active_library[0], Settings())
    try:
        with TestClient(app) as client:
            initial = client.patch(PLAYBACK_URL, json=playback_payload(first_library))
            assert initial.status_code == 200
            active_library[0] = second_library
            rejected = client.patch(
                PLAYBACK_URL, json=playback_payload(first_library, position_seconds=80)
            )
            assert rejected.status_code == 409
            assert client.get(PLAYBACK_URL).json()["position_seconds"] == 0
            assert client.get(RECENT_URL).json() == []
            active_library[0] = first_library
            assert client.get(PLAYBACK_URL).json()["position_seconds"] == 30.5
    finally:
        first_library.close()
        second_library.close()


@pytest.mark.parametrize("delete_index", [False, True])
def test_playback_restores_from_video_configuration_after_reopen_or_index_rebuild(
    playback_library, delete_index: bool
):
    client, library = playback_library
    saved = client.patch(PLAYBACK_URL, json=playback_payload(library)).json()
    library_path = library.library_path
    library.close()
    if delete_index:
        (library_path / DATABASE_FILE_NAME).unlink()
    reopened = MediaLibrary.open(library_path)
    try:
        with playback_client(reopened) as reopened_client:
            assert reopened_client.get(PLAYBACK_URL).json() == saved
            recent = reopened_client.get(RECENT_URL).json()
            assert [asset["asset_id"] for asset in recent] == [ASSET_ID]
            assert recent[0]["playback"]["position_seconds"] == 30.5
            assert recent[0]["playback"]["playback_rate"] == 1.5
    finally:
        reopened.close()


def test_older_library_adds_playback_projection_without_rebuilding_content_index(
    playback_library,
):
    client, library = playback_library
    saved = client.patch(PLAYBACK_URL, json=playback_payload(library)).json()
    connection = library._db()
    index_before = [
        tuple(row) for row in connection.execute("SELECT * FROM index_states")
    ]
    with connection:
        connection.execute("DROP TABLE playback_progress")
    library_path = library.library_path
    library.close()
    reopened = MediaLibrary.open(library_path)
    try:
        with playback_client(reopened) as reopened_client:
            assert reopened_client.get(PLAYBACK_URL).json() == saved
            recent = reopened_client.get(RECENT_URL).json()
            assert [asset["asset_id"] for asset in recent] == [ASSET_ID]
            index_after = [
                tuple(row)
                for row in reopened._db().execute("SELECT * FROM index_states")
            ]
            assert index_after == index_before
    finally:
        reopened.close()


def test_recent_playback_sorts_limits_and_excludes_unwatched_unready_images_missing_files(
    playback_library,
):
    client, library = playback_library
    watched_ids = [ASSET_ID, *(str(uuid7()) for _ in range(7))]
    for index, asset_id in enumerate(watched_ids):
        if asset_id != ASSET_ID:
            save_playable_asset(library, asset_id, f"课程{index}")
        response = client.patch(
            f"/api/media/assets/{asset_id}/playback", json=playback_payload(library)
        )
        assert response.status_code == 200
    unwatched_id = str(uuid7())
    save_playable_asset(library, unwatched_id, "未观看")

    default_recent = client.get(RECENT_URL).json()
    assert [asset["asset_id"] for asset in default_recent] == list(
        reversed(watched_ids)
    )[:6]
    assert [
        asset["asset_id"]
        for asset in client.get(RECENT_URL, params={"limit": 1}).json()
    ] == [watched_ids[-1]]

    image_asset = library.get(watched_ids[-1])
    image_asset.media_type = MediaType.IMAGE
    library.save(image_asset)
    unready_asset = library.get(watched_ids[-2])
    unready_asset.status = MediaAssetStatus.PROCESSING
    library.save(unready_asset)
    (library.asset_directory(watched_ids[-3]) / "playback.mp4").unlink()
    library.delete_asset(watched_ids[-4])
    recent = client.get(RECENT_URL, params={"limit": 50}).json()
    assert [asset["asset_id"] for asset in recent] == list(reversed(watched_ids[:-4]))
    limited_recent = client.get(RECENT_URL, params={"limit": 1}).json()
    assert [asset["asset_id"] for asset in limited_recent] == [watched_ids[-5]]


def test_recent_playback_orders_imported_timezone_timestamps_by_utc(playback_library):
    client, library = playback_library
    second_asset_id = str(uuid7())
    save_playable_asset(library, second_asset_id)
    for asset_id, watched_at in [
        (ASSET_ID, "2026-10-10T03:00:00+08:00"),
        (second_asset_id, "2026-10-09T23:00:00+00:00"),
    ]:
        response = client.patch(
            f"/api/media/assets/{asset_id}/playback", json=playback_payload(library)
        )
        assert response.status_code == 200
        configuration_path = (
            library.asset_directory(asset_id) / VIDEO_CONFIGURATION_FILE_NAME
        )
        configuration = json.loads(configuration_path.read_text(encoding="utf-8"))
        configuration["playback"]["last_watched_at"] = watched_at
        configuration_path.write_text(json.dumps(configuration), encoding="utf-8")
    library_path = library.library_path
    library.close()
    reopened = MediaLibrary.open(library_path)
    try:
        with playback_client(reopened) as reopened_client:
            recent = reopened_client.get(RECENT_URL).json()
            assert [asset["asset_id"] for asset in recent] == [
                second_asset_id,
                ASSET_ID,
            ]
    finally:
        reopened.close()


def test_recent_playback_streams_in_index_order_without_temporary_sort(
    playback_library,
):
    client, library = playback_library
    assert client.patch(PLAYBACK_URL, json=playback_payload(library)).status_code == 200
    statements: list[str] = []
    connection = library._db()
    connection.set_trace_callback(statements.append)
    try:
        assert library.recent_media(6)
    finally:
        connection.set_trace_callback(None)
    recent_query = next(
        statement
        for statement in statements
        if statement.lstrip().startswith("SELECT")
        and "FROM playback_progress" in statement
        and "ORDER BY progress.last_watched_at" in statement
    )
    query_plan = connection.execute(f"EXPLAIN QUERY PLAN {recent_query}").fetchall()
    details = "\n".join(row[3] for row in query_plan)
    assert "playback_progress_recent_index" in details
    assert "USE TEMP B-TREE" not in details


@pytest.mark.parametrize("damage", ["invalid_json", "cross_asset", "symlink"])
def test_invalid_watched_configuration_falls_back_without_hiding_asset(
    playback_library, damage: str
):
    client, library = playback_library
    assert client.patch(PLAYBACK_URL, json=playback_payload(library)).status_code == 200
    asset_directory = library.asset_directory(ASSET_ID)
    configuration_path = asset_directory / VIDEO_CONFIGURATION_FILE_NAME
    metadata_path = asset_directory / ASSET_METADATA_FILE_NAME
    metadata_before = metadata_path.read_bytes()
    configuration_text = configuration_path.read_text(encoding="utf-8")
    if damage == "invalid_json":
        configuration_path.write_text("{broken", encoding="utf-8")
    elif damage == "cross_asset":
        configuration = json.loads(configuration_text)
        configuration["asset_id"] = str(uuid7())
        configuration_path.write_text(json.dumps(configuration), encoding="utf-8")
    else:
        target_path = library.library_path / "redirected-config.json"
        target_path.write_text(configuration_text, encoding="utf-8")
        configuration_path.unlink()
        configuration_path.symlink_to(target_path)

    assert client.get(PLAYBACK_URL).json()["last_watched_at"] is None
    assert client.get(PLAYBACK_URL).json()["position_seconds"] == 0
    library_path = library.library_path
    library.close()
    reopened = MediaLibrary.open(library_path)
    try:
        with playback_client(reopened) as reopened_client:
            restored_asset = reopened.get(ASSET_ID)
            assert restored_asset is not None
            assert restored_asset.status == MediaAssetStatus.READY
            assert reopened_client.get(PLAYBACK_URL).json()["last_watched_at"] is None
            assert reopened_client.get(RECENT_URL).json() == []
            assert (
                reopened._db()
                .execute(
                    "SELECT asset_id FROM playback_progress WHERE asset_id = ?",
                    (ASSET_ID,),
                )
                .fetchone()
                is None
            )
            assert metadata_path.read_bytes() == metadata_before
            if damage == "symlink":
                assert target_path.read_text(encoding="utf-8") == configuration_text
    finally:
        reopened.close()


@pytest.mark.parametrize("limit", [0, -1, 51, "invalid"])
def test_recent_playback_validates_limit(playback_library, limit):
    client, _library = playback_library
    assert client.get(RECENT_URL, params={"limit": limit}).status_code == 422


def test_deleting_an_asset_removes_its_playback_projection(playback_library):
    client, library = playback_library
    assert client.patch(PLAYBACK_URL, json=playback_payload(library)).status_code == 200
    assert (
        library._db()
        .execute(
            "SELECT asset_id FROM playback_progress WHERE asset_id = ?", (ASSET_ID,)
        )
        .fetchone()
        is not None
    )
    library.delete_asset(ASSET_ID)
    assert (
        library._db()
        .execute(
            "SELECT asset_id FROM playback_progress WHERE asset_id = ?", (ASSET_ID,)
        )
        .fetchone()
        is None
    )
    assert client.get(RECENT_URL).json() == []


def test_playback_saves_do_not_change_content_metadata_or_evidence_digest(
    playback_library,
):
    client, library = playback_library
    library.save_transcript(
        Transcript(
            asset_id=ASSET_ID,
            segments=[
                TranscriptSegment(start_seconds=0, end_seconds=10, text="课程知识")
            ],
        )
    )
    metadata_path = library.asset_directory(ASSET_ID) / ASSET_METADATA_FILE_NAME
    metadata_before = metadata_path.read_bytes()
    updated_at_before = library.get(ASSET_ID).updated_at
    connection = library._db()
    index_before = [
        tuple(row) for row in connection.execute("SELECT * FROM index_states")
    ]
    evidence_before = [
        tuple(row)
        for row in connection.execute("SELECT * FROM agent_evidence_asset_states")
    ]
    documents_before = [
        tuple(row)
        for row in connection.execute(
            "SELECT * FROM agent_evidence_documents ORDER BY document_id"
        )
    ]

    response = client.patch(PLAYBACK_URL, json=playback_payload(library))
    assert response.status_code == 200
    assert library.get(ASSET_ID).updated_at == updated_at_before
    assert metadata_path.read_bytes() == metadata_before
    assert [
        tuple(row) for row in connection.execute("SELECT * FROM index_states")
    ] == index_before
    assert [
        tuple(row)
        for row in connection.execute("SELECT * FROM agent_evidence_asset_states")
    ] == evidence_before
    assert [
        tuple(row)
        for row in connection.execute(
            "SELECT * FROM agent_evidence_documents ORDER BY document_id"
        )
    ] == documents_before


def test_concurrent_subtitle_and_playback_saves_preserve_both_fields(playback_library):
    client, library = playback_library
    for update_index in range(1, 6):
        start_barrier = Barrier(2)
        offset_milliseconds = update_index * 100
        position_seconds = update_index * 5

        def save_subtitle():
            start_barrier.wait(timeout=5)
            return client.patch(
                f"/api/media/assets/{ASSET_ID}/subtitle-settings",
                json={"offset_milliseconds": offset_milliseconds},
            )

        def save_playback():
            start_barrier.wait(timeout=5)
            return client.patch(
                PLAYBACK_URL,
                json=playback_payload(library, position_seconds=position_seconds),
            )

        with ThreadPoolExecutor(max_workers=2) as executor:
            subtitle_future = executor.submit(save_subtitle)
            playback_future = executor.submit(save_playback)
            assert subtitle_future.result(timeout=10).status_code == 200
            assert playback_future.result(timeout=10).status_code == 200
        configuration_path = (
            library.asset_directory(ASSET_ID) / VIDEO_CONFIGURATION_FILE_NAME
        )
        configuration = json.loads(configuration_path.read_text(encoding="utf-8"))
        assert (
            configuration["subtitle_display"]["offset_milliseconds"]
            == offset_milliseconds
        )
        assert configuration["playback"]["position_seconds"] == position_seconds


@pytest.mark.parametrize(
    "observed_at",
    [
        "2026-10-17T01:59:59.999Z",
        "2026-10-17T02:00:00Z",
        "2026-10-16T22:00:00-04:00",
    ],
)
def test_late_or_duplicate_samples_preserve_the_final_saved_state(
    playback_library, observed_at: str
):
    client, library = playback_library
    final = client.patch(
        PLAYBACK_URL,
        json=playback_payload(
            library, position_seconds=90, observed_at="2026-10-17T10:00:00+08:00"
        ),
    )
    assert final.status_code == 200
    path = library.asset_directory(ASSET_ID) / VIDEO_CONFIGURATION_FILE_NAME
    configuration_before = path.read_bytes()
    modified_at_before = path.stat().st_mtime_ns
    projection_before = tuple(
        library._db()
        .execute("SELECT * FROM playback_progress WHERE asset_id = ?", (ASSET_ID,))
        .fetchone()
    )

    late = client.patch(
        PLAYBACK_URL,
        json=playback_payload(
            library, position_seconds=20, playback_rate=2, observed_at=observed_at
        ),
    )

    assert late.status_code == 200
    assert late.json() == final.json()
    assert path.read_bytes() == configuration_before
    assert path.stat().st_mtime_ns == modified_at_before
    assert (
        tuple(
            library._db()
            .execute("SELECT * FROM playback_progress WHERE asset_id = ?", (ASSET_ID,))
            .fetchone()
        )
        == projection_before
    )


def test_newer_sample_can_seek_backwards_without_reusing_the_client_clock_for_recency(
    playback_library,
):
    client, library = playback_library
    previous = client.patch(
        PLAYBACK_URL,
        json=playback_payload(
            library, position_seconds=90, observed_at="2020-01-01T10:00:00+08:00"
        ),
    )
    saved = client.patch(
        PLAYBACK_URL,
        json=playback_payload(
            library,
            position_seconds=3,
            playback_rate=2,
            observed_at="2020-01-01T02:00:00.001Z",
        ),
    )

    assert previous.status_code == saved.status_code == 200
    assert saved.json()["position_seconds"] == 3
    assert saved.json()["playback_rate"] == 2
    assert saved.json()["observed_at"] == "2020-01-01T02:00:00.001000Z"
    assert datetime.fromisoformat(
        saved.json()["last_watched_at"]
    ) >= datetime.fromisoformat(previous.json()["last_watched_at"])
    assert datetime.fromisoformat(saved.json()["last_watched_at"]).year > 2020


@pytest.mark.parametrize("observed_at", ["2026-10-17T10:00:00", "not-a-date"])
def test_playback_observation_requires_an_aware_datetime(playback_library, observed_at):
    client, library = playback_library
    response = client.patch(
        PLAYBACK_URL,
        json=playback_payload(library, observed_at=observed_at),
    )
    assert response.status_code == 422
    assert client.get(PLAYBACK_URL).json()["last_watched_at"] is None


def test_old_configuration_without_observation_is_readable_and_new_order_survives_reopen(
    playback_library,
):
    client, library = playback_library
    assert client.patch(PLAYBACK_URL, json=playback_payload(library)).status_code == 200
    path = library.asset_directory(ASSET_ID) / VIDEO_CONFIGURATION_FILE_NAME
    configuration = json.loads(path.read_text(encoding="utf-8"))
    configuration["playback"].pop("observed_at")
    path.write_text(json.dumps(configuration), encoding="utf-8")
    old = client.get(PLAYBACK_URL)
    assert old.status_code == 200
    assert old.json()["observed_at"] is None
    assert old.json()["position_seconds"] == 30.5
    assert old.json()["playback_rate"] == 1.5

    newest = client.patch(
        PLAYBACK_URL,
        json=playback_payload(
            library, position_seconds=80, observed_at="2026-10-17T02:00:00Z"
        ),
    )
    assert newest.status_code == 200
    library.close()
    reopened = MediaLibrary.open(library.library_path)
    try:
        with playback_client(reopened) as reopened_client:
            rejected = reopened_client.patch(
                PLAYBACK_URL,
                json=playback_payload(
                    reopened, position_seconds=40, observed_at="2026-10-17T01:59:59Z"
                ),
            )
            assert rejected.status_code == 200
            assert rejected.json() == newest.json()
    finally:
        reopened.close()
