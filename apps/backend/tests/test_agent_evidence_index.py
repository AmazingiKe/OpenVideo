import re
from array import array
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event

import pytest

from openvideo.core import agent_evidence_index
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import (
    MediaAsset,
    MediaAssetStatus,
    MediaSegment,
    SourcePlatform,
)
from openvideo.core.transcription_models import Transcript, TranscriptSegment


FIRST_ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"
SECOND_ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c073990"
TEST_NEURAL_MODEL = "test/neural-video-retrieval"
TEST_NEURAL_VERSION = "revision-1"
TEST_NEURAL_DIMENSIONS = 4
INDEX_BUILD_WAIT_SECONDS = 10


def _test_vector(value: str) -> list[float]:
    normalized = value.casefold()
    vector = [
        float(any(term in normalized for term in ("量子", "并行", "quantum"))),
        float(any(term in normalized for term in ("神经", "人工智能", "ai"))),
        float(any(term in normalized for term in ("透视", "相机", "projection"))),
        0.1,
    ]
    magnitude = sum(component * component for component in vector) ** 0.5
    return [component / magnitude for component in vector]


def _encode_test_documents(texts, report_progress):
    vectors = []
    for position, text in enumerate(texts, start=1):
        vectors.append(_test_vector(text))
        report_progress("embedding_documents", position, len(texts))
    return vectors


def _encode_test_query(query, model_name, model_version, dimensions):
    if (
        model_name != TEST_NEURAL_MODEL
        or model_version != TEST_NEURAL_VERSION
        or dimensions != TEST_NEURAL_DIMENSIONS
    ):
        return []
    return _test_vector(query)


def _save_asset(library: MediaLibrary, asset_id: str, title: str) -> MediaAsset:
    asset = MediaAsset(
        asset_id=asset_id,
        source_url=f"https://example.com/{asset_id}",
        source_platform=SourcePlatform.YOUTUBE,
        title=title,
        duration_seconds=800,
        status=MediaAssetStatus.READY,
    )
    library.save(asset)
    return asset


def _save_transcript(
    library: MediaLibrary,
    asset_id: str,
    segments: list[tuple[float, float, str]],
) -> None:
    library.save_transcript(
        Transcript(
            asset_id=asset_id,
            segments=[
                TranscriptSegment(
                    start_seconds=start,
                    end_seconds=end,
                    text=text,
                )
                for start, end, text in segments
            ],
        )
    )


@pytest.fixture
def neural_library(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    try:
        _save_asset(library, FIRST_ASSET_ID, "芯片课程")
        _save_asset(library, SECOND_ASSET_ID, "图形课程")
        _save_transcript(
            library,
            FIRST_ASSET_ID,
            [(0, 20, "神经网络基础"), (20, 40, "人工智能推理")],
        )
        _save_transcript(
            library,
            SECOND_ASSET_ID,
            [(0, 20, "透视投影基础"), (20, 40, "相机参数调整")],
        )
        status = library.rebuild_agent_semantic_index(
            model_name=TEST_NEURAL_MODEL,
            model_version=TEST_NEURAL_VERSION,
            dimensions=TEST_NEURAL_DIMENSIONS,
            encode_documents=_encode_test_documents,
        )
        yield library, status
    finally:
        library.close()


def test_sqlite_retrieval_filters_time_and_samples_long_overview(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, FIRST_ASSET_ID, "长视频")
    _save_transcript(
        library,
        FIRST_ASSET_ID,
        [
            (position * 100, position * 100 + 20, f"第 {position + 1} 章 神经网络")
            for position in range(8)
        ],
    )

    ranged = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query="神经网络",
        start_seconds=300,
        end_seconds=420,
        limit=4,
    )
    overview = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query=None,
        start_seconds=None,
        end_seconds=None,
        limit=4,
    )

    assert ranged
    assert all(item.end_seconds >= 300 and item.start_seconds <= 420 for item in ranged)
    assert len(overview) == 4
    assert overview[0].start_seconds < 100
    assert overview[-1].start_seconds >= 600
    library.close()


def test_query_rerank_preserves_sources_and_expands_neighbors(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, FIRST_ASSET_ID, "图形课程")
    _save_transcript(
        library,
        FIRST_ASSET_ID,
        [
            (0, 20, "开始介绍相机参数"),
            (20, 40, "核心结论是透视投影影响视角"),
            (40, 60, "随后展示调整前后的结果"),
        ],
    )
    library.save_segments(
        FIRST_ASSET_ID,
        [
            MediaSegment(
                segment_id=f"segment-{FIRST_ASSET_ID.replace('-', '')}",
                asset_id=FIRST_ASSET_ID,
                start_seconds=500,
                end_seconds=520,
                title="透视章节",
                detailed_summary="透视投影影响空间关系",
                transcript_text="讲师解释透视投影",
                visual_description="画面展示透视投影示意图",
                ocr_text="板书文字为透视投影公式",
                formula_latex=[r"\hat{a}=\vec{a}/\|\vec{a}\|"],
            )
        ],
    )

    evidence = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query="透视投影",
        start_seconds=None,
        end_seconds=None,
        limit=6,
    )

    assert {item.source_type for item in evidence} == {
        "analysis",
        "ocr",
        "transcript",
        "visual",
    }
    assert any(item.start_seconds == 20 for item in evidence)
    assert any(item.retrieval_relation == "neighbor" for item in evidence)
    formula_evidence = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query="画面公式",
        start_seconds=None,
        end_seconds=None,
        limit=6,
    )
    assert any(
        item.text == r"画面公式：$$\hat{a}=\vec{a}/\|\vec{a}\|$$"
        for item in formula_evidence
    )
    library.close()


def test_one_index_query_retrieves_across_assets(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, FIRST_ASSET_ID, "图形课程")
    _save_asset(library, SECOND_ASSET_ID, "音频课程")
    _save_transcript(
        library,
        FIRST_ASSET_ID,
        [(0, 20, "全局光照影响间接反射")],
    )
    _save_transcript(
        library,
        SECOND_ASSET_ID,
        [(0, 20, "动态压缩控制声音峰值")],
    )

    evidence = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID, SECOND_ASSET_ID],
        query="间接反射",
        start_seconds=None,
        end_seconds=None,
        limit=6,
    )

    assert evidence
    assert {item.asset_id for item in evidence} == {FIRST_ASSET_ID}
    library.close()


def test_existing_library_backfills_agent_projection_without_rebuilding_runtime(
    tmp_path: Path,
):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, FIRST_ASSET_ID, "旧资料库")
    _save_transcript(
        library,
        FIRST_ASSET_ID,
        [(0, 20, "迁移后仍能检索原始转录")],
    )
    with library._db():
        for table_name in (
            "agent_evidence_fts",
            "agent_verified_memory_fts",
            "agent_evidence_embeddings",
            "agent_semantic_models",
            "agent_evidence_index_status",
            "agent_verified_memories",
            "agent_evidence_documents",
            "agent_evidence_asset_states",
        ):
            library._db().execute(f"DROP TABLE {table_name}")
    library.close()

    reopened = MediaLibrary.open(tmp_path)
    evidence = reopened.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query="原始转录",
        start_seconds=None,
        end_seconds=None,
        limit=4,
    )

    assert evidence[0].text == "迁移后仍能检索原始转录"
    assert reopened.load_agent_sessions() == []
    reopened.close()


def test_semantic_generation_swaps_atomically_and_keeps_stable_documents(
    tmp_path: Path,
):
    library = MediaLibrary.initialize_directory(tmp_path)
    asset = _save_asset(library, FIRST_ASSET_ID, "芯片课程")
    _save_transcript(
        library,
        FIRST_ASSET_ID,
        [(0, 20, "神经网络芯片用于人工智能推理")],
    )
    first_document = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query="神经网络芯片",
        start_seconds=None,
        end_seconds=None,
        limit=4,
    )[0]
    first_status = library.rebuild_agent_semantic_index(
        model_name=TEST_NEURAL_MODEL,
        model_version=TEST_NEURAL_VERSION,
        dimensions=TEST_NEURAL_DIMENSIONS,
        encode_documents=_encode_test_documents,
    )

    asset.title = "芯片课程（已校对）"
    library.save(asset)
    stable_document = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query="神经网络芯片",
        start_seconds=None,
        end_seconds=None,
        limit=4,
    )[0]
    stable_status = library.agent_evidence_index_status()

    assert stable_document.document_id == first_document.document_id
    assert stable_status.state == "ready"
    assert stable_status.active_model == first_status.active_model

    _save_transcript(
        library,
        FIRST_ASSET_ID,
        [(0, 20, "量子处理芯片用于并行模拟")],
    )
    stale_status = library.agent_evidence_index_status()
    changed_document = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query="量子处理芯片",
        start_seconds=None,
        end_seconds=None,
        limit=4,
    )[0]

    assert stale_status.state == "lexical_ready"
    assert stale_status.active_model == first_status.active_model
    assert changed_document.document_id != first_document.document_id

    rebuilt_status = library.rebuild_agent_semantic_index(
        model_name=TEST_NEURAL_MODEL,
        model_version=TEST_NEURAL_VERSION,
        dimensions=TEST_NEURAL_DIMENSIONS,
        encode_documents=_encode_test_documents,
    )
    semantic_result = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query="量子芯片并行计算",
        start_seconds=None,
        end_seconds=None,
        limit=4,
        query_encoder=_encode_test_query,
    )

    assert rebuilt_status.state == "ready"
    assert rebuilt_status.active_model != first_status.active_model
    assert "神经语义向量匹配" in semantic_result[0].match_reasons
    assert (
        library._db()
        .execute("SELECT COUNT(*) FROM agent_semantic_models WHERE active = 1")
        .fetchone()[0]
        == 1
    )
    library.close()


def test_neural_model_loading_reports_stage_without_fake_progress(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, FIRST_ASSET_ID, "索引进度课程")
    _save_transcript(
        library,
        FIRST_ASSET_ID,
        [(0, 20, "真实进度不能用估算百分比替代")],
    )
    projection_started = Event()
    release_projection = Event()

    def blocked_encoder(texts, report_progress):
        del report_progress
        projection_started.set()
        release_projection.wait(timeout=5)
        return [_test_vector(text) for text in texts]

    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(
                library.rebuild_agent_semantic_index,
                model_name=TEST_NEURAL_MODEL,
                model_version=TEST_NEURAL_VERSION,
                dimensions=TEST_NEURAL_DIMENSIONS,
                encode_documents=blocked_encoder,
            )
            assert projection_started.wait(timeout=5)
            status = library.agent_evidence_index_status()
            coverage = library.agent_evidence_index_coverage(FIRST_ASSET_ID)

            assert status.state == "semantic_building"
            assert status.stage == "loading_embedding_model"
            assert status.processed_documents == 0
            assert status.total_documents == 0
            assert coverage.covered_seconds == 20
            assert coverage.document_count == 1
            release_projection.set()
            assert future.result(timeout=5).state == "ready"
    finally:
        release_projection.set()
        library.close()


def test_neural_rebuild_only_encodes_added_and_changed_documents(neural_library):
    library, previous_status = neural_library
    previous_vectors = dict(
        library._db().execute(
            "SELECT document_id, vector FROM agent_evidence_embeddings"
        )
    )
    _save_transcript(
        library,
        FIRST_ASSET_ID,
        [
            (0, 20, "神经网络基础"),
            (20, 40, "量子处理芯片"),
            (40, 60, "量子并行计算"),
        ],
    )
    encoded_texts = []

    def encode_changed_documents(texts, report_progress):
        encoded_texts.extend(texts)
        current_status = library.agent_evidence_index_status()
        assert current_status.active_model == previous_status.active_model
        return _encode_test_documents(texts, report_progress)

    status = library.rebuild_agent_semantic_index(
        model_name=TEST_NEURAL_MODEL,
        model_version=TEST_NEURAL_VERSION,
        dimensions=TEST_NEURAL_DIMENSIONS,
        encode_documents=encode_changed_documents,
    )
    current_vectors = dict(
        library._db().execute(
            "SELECT document_id, vector FROM agent_evidence_embeddings"
        )
    )
    retained_ids = previous_vectors.keys() & current_vectors.keys()
    model_count = (
        library._db()
        .execute("SELECT COUNT(*) FROM agent_semantic_models")
        .fetchone()[0]
    )

    assert encoded_texts == ["\n量子处理芯片", "\n量子并行计算"]
    assert len(current_vectors) == 5
    assert len(retained_ids) == 3
    assert all(current_vectors[key] == previous_vectors[key] for key in retained_ids)
    assert status.state == "ready"
    assert status.processed_documents == status.total_documents == 5
    assert status.active_model != previous_status.active_model
    assert model_count == 1


def test_neural_rebuild_after_asset_deletion_never_calls_encoder(neural_library):
    library, previous_status = neural_library
    library.delete_asset(FIRST_ASSET_ID)
    remaining_vectors = dict(
        library._db().execute(
            "SELECT document_id, vector FROM agent_evidence_embeddings"
        )
    )

    def unexpected_encoding(_texts, _report_progress):
        raise AssertionError("删除素材后只需复用剩余向量，不应加载或调用模型")

    status = library.rebuild_agent_semantic_index(
        model_name=TEST_NEURAL_MODEL,
        model_version=TEST_NEURAL_VERSION,
        dimensions=TEST_NEURAL_DIMENSIONS,
        encode_documents=unexpected_encoding,
    )
    current_vectors = dict(
        library._db().execute(
            "SELECT document_id, vector FROM agent_evidence_embeddings"
        )
    )

    assert len(current_vectors) == 2
    assert current_vectors == remaining_vectors
    assert status.state == "ready"
    assert status.active_model != previous_status.active_model
    assert status.processed_documents == status.total_documents == 2


@pytest.mark.parametrize(
    ("model_name", "model_version", "dimensions", "previous_kind"),
    [
        ("test/other-model", TEST_NEURAL_VERSION, TEST_NEURAL_DIMENSIONS, "neural"),
        (TEST_NEURAL_MODEL, "revision-2", TEST_NEURAL_DIMENSIONS, "neural"),
        (TEST_NEURAL_MODEL, TEST_NEURAL_VERSION, TEST_NEURAL_DIMENSIONS + 1, "neural"),
        (TEST_NEURAL_MODEL, TEST_NEURAL_VERSION, TEST_NEURAL_DIMENSIONS, "lsa"),
    ],
)
def test_neural_rebuild_recomputes_when_model_identity_changes(
    neural_library, model_name, model_version, dimensions, previous_kind
):
    library, _previous_status = neural_library
    with library._db():
        library._db().execute(
            "UPDATE agent_semantic_models SET model_kind = ?", (previous_kind,)
        )
    encoded_texts = []

    def encode_target_model(texts, report_progress):
        encoded_texts.extend(texts)
        vectors = _encode_test_documents(texts, report_progress)
        return [vector + [0.0] * (dimensions - len(vector)) for vector in vectors]

    status = library.rebuild_agent_semantic_index(
        model_name=model_name,
        model_version=model_version,
        dimensions=dimensions,
        encode_documents=encode_target_model,
    )
    model = (
        library._db()
        .execute(
            "SELECT model_name, model_version, model_kind, dimensions "
            "FROM agent_semantic_models WHERE active = 1"
        )
        .fetchone()
    )

    assert len(encoded_texts) == 4
    assert status.state == "ready"
    assert tuple(model) == (model_name, model_version, "neural", dimensions)


@pytest.mark.parametrize(
    "cached_vector",
    [
        pytest.param(None, id="missing"),
        pytest.param(b"broken", id="malformed"),
        pytest.param("invalid", id="wrong-type"),
        pytest.param(array("f", [1.0]).tobytes(), id="wrong-dimensions"),
        pytest.param(
            array("f", [float("nan")] * TEST_NEURAL_DIMENSIONS).tobytes(), id="nan"
        ),
        pytest.param(
            array("f", [float("inf")] * TEST_NEURAL_DIMENSIONS).tobytes(), id="infinity"
        ),
    ],
)
def test_neural_rebuild_recomputes_only_invalid_cached_vectors(
    neural_library, cached_vector
):
    library, _previous_status = neural_library
    document = (
        library._db()
        .execute(
            "SELECT document_id, text FROM agent_evidence_documents "
            "ORDER BY asset_id, start_seconds LIMIT 1"
        )
        .fetchone()
    )
    with library._db():
        if cached_vector is None:
            library._db().execute(
                "DELETE FROM agent_evidence_embeddings WHERE document_id = ?",
                (document["document_id"],),
            )
        else:
            library._db().execute(
                "UPDATE agent_evidence_embeddings SET vector = ? WHERE document_id = ?",
                (cached_vector, document["document_id"]),
            )
    encoded_texts = []

    def encode_invalid_cache(texts, report_progress):
        encoded_texts.extend(texts)
        return _encode_test_documents(texts, report_progress)

    status = library.rebuild_agent_semantic_index(
        model_name=TEST_NEURAL_MODEL,
        model_version=TEST_NEURAL_VERSION,
        dimensions=TEST_NEURAL_DIMENSIONS,
        encode_documents=encode_invalid_cache,
    )
    repaired_vector = (
        library._db()
        .execute(
            "SELECT vector FROM agent_evidence_embeddings WHERE document_id = ?",
            (document["document_id"],),
        )
        .fetchone()["vector"]
    )

    assert encoded_texts == [f"\n{document['text']}"]
    assert status.state == "ready"
    assert repaired_vector == array("f", _test_vector(document["text"])).tobytes()


def test_incremental_neural_rebuild_discards_concurrently_invalidated_generation(
    neural_library,
):
    library, previous_status = neural_library
    _save_transcript(
        library,
        FIRST_ASSET_ID,
        [(0, 20, "神经网络基础"), (20, 40, "人工智能推理"), (40, 60, "新增量子课程")],
    )
    encoding_started = Event()
    finish_encoding = Event()
    encoded_texts = []

    def pause_encoding(texts, report_progress):
        encoded_texts.extend(texts)
        encoding_started.set()
        assert finish_encoding.wait(INDEX_BUILD_WAIT_SECONDS)
        return _encode_test_documents(texts, report_progress)

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(
            library.rebuild_agent_semantic_index,
            model_name=TEST_NEURAL_MODEL,
            model_version=TEST_NEURAL_VERSION,
            dimensions=TEST_NEURAL_DIMENSIONS,
            encode_documents=pause_encoding,
        )
        try:
            assert encoding_started.wait(INDEX_BUILD_WAIT_SECONDS)
            _save_transcript(
                library,
                SECOND_ASSET_ID,
                [(0, 20, "已校正的透视投影"), (20, 40, "相机参数调整")],
            )
        finally:
            finish_encoding.set()
        invalidated_status = future.result(timeout=INDEX_BUILD_WAIT_SECONDS)

    assert encoded_texts == ["\n新增量子课程"]
    assert invalidated_status.state == "lexical_ready"
    assert invalidated_status.active_model == previous_status.active_model
    model_count = (
        library._db()
        .execute("SELECT COUNT(*) FROM agent_semantic_models")
        .fetchone()[0]
    )
    assert model_count == 1
    encoded_texts.clear()

    def encode_latest_changes(texts, report_progress):
        encoded_texts.extend(texts)
        return _encode_test_documents(texts, report_progress)

    rebuilt_status = library.rebuild_agent_semantic_index(
        model_name=TEST_NEURAL_MODEL,
        model_version=TEST_NEURAL_VERSION,
        dimensions=TEST_NEURAL_DIMENSIONS,
        encode_documents=encode_latest_changes,
    )

    assert encoded_texts == ["\n新增量子课程", "\n已校正的透视投影"]
    assert rebuilt_status.state == "ready"
    assert rebuilt_status.active_model != previous_status.active_model
    assert rebuilt_status.total_documents == 5


def test_neural_rebuild_uses_digest_of_the_document_snapshot(
    neural_library, monkeypatch
):
    library, previous_status = neural_library
    original_content_digest = agent_evidence_index._content_digest
    snapshot_pending = True

    def add_document_after_snapshot(connection, *, rows=None):
        nonlocal snapshot_pending
        if snapshot_pending:
            snapshot_pending = False
            _save_transcript(
                library,
                FIRST_ASSET_ID,
                [
                    (0, 20, "神经网络基础"),
                    (20, 40, "人工智能推理"),
                    (40, 60, "并发新增内容"),
                ],
            )
        return original_content_digest(connection, rows=rows)

    monkeypatch.setattr(
        agent_evidence_index, "_content_digest", add_document_after_snapshot
    )

    def unexpected_encoding(_texts, _report_progress):
        raise AssertionError("快照中的文档都有有效缓存，不应重新计算")

    status = library.rebuild_agent_semantic_index(
        model_name=TEST_NEURAL_MODEL,
        model_version=TEST_NEURAL_VERSION,
        dimensions=TEST_NEURAL_DIMENSIONS,
        encode_documents=unexpected_encoding,
    )

    assert status.state == "lexical_ready"
    assert status.total_documents == 5
    assert status.active_model == previous_status.active_model


def test_unrelated_metadata_save_does_not_rewrite_evidence_projection(neural_library):
    library, previous_status = neural_library
    asset = library.get(FIRST_ASSET_ID)
    assert asset is not None
    asset.title = "课程资料已整理"
    statements = []
    connection = library._db()
    connection.set_trace_callback(statements.append)
    try:
        library.save(asset)
    finally:
        connection.set_trace_callback(None)
    evidence_writes = [
        statement
        for statement in statements
        if re.match(
            r"^\s*(?:INSERT INTO|UPDATE|DELETE FROM) agent_evidence_(?:fts|documents)\b",
            statement,
            re.IGNORECASE,
        )
    ]
    status = library.agent_evidence_index_status()

    assert evidence_writes == []
    assert status.state == "ready"
    assert status.active_model == previous_status.active_model


def test_changed_text_updates_search_without_rewriting_other_fts_rows(neural_library):
    library, _previous_status = neural_library
    previous_rows = dict(
        library._db().execute("SELECT document_id, rowid FROM agent_evidence_fts")
    )
    _save_transcript(
        library,
        FIRST_ASSET_ID,
        [(0, 20, "神经网络基础"), (20, 40, "量子处理芯片")],
    )
    current_rows = dict(
        library._db().execute("SELECT document_id, rowid FROM agent_evidence_fts")
    )
    retained_ids = previous_rows.keys() & current_rows.keys()
    new_results = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query="量子处理芯片",
        start_seconds=None,
        end_seconds=None,
        limit=4,
    )
    removed_results = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query="人工智能推理",
        start_seconds=None,
        end_seconds=None,
        limit=4,
    )

    assert len(current_rows) == 4
    assert len(retained_ids) == 3
    assert all(current_rows[key] == previous_rows[key] for key in retained_ids)
    assert any(item.text == "量子处理芯片" for item in new_results)
    assert removed_results == []


def test_existing_index_status_schema_migrates_without_rebuilding_library(
    tmp_path: Path,
):
    library = MediaLibrary.initialize_directory(tmp_path)
    with library._db():
        library._db().execute("DROP TABLE agent_evidence_index_status")
        library._db().execute(
            "CREATE TABLE agent_evidence_index_status ("
            "singleton INTEGER PRIMARY KEY CHECK(singleton = 1), "
            "state TEXT NOT NULL, processed_documents INTEGER NOT NULL, "
            "total_documents INTEGER NOT NULL, active_model TEXT, "
            "content_digest TEXT NOT NULL, error_message TEXT, "
            "updated_at TEXT NOT NULL)"
        )
        library._db().execute(
            "INSERT INTO agent_evidence_index_status VALUES "
            "(1, 'ready', 3, 3, NULL, 'digest', NULL, "
            "'2026-08-29T10:00:00+00:00')"
        )
    library.close()

    reopened = MediaLibrary.open(tmp_path)
    status = reopened.agent_evidence_index_status()

    assert status.stage == "ready"
    assert re.fullmatch(r"index-task-[0-9a-f]{32}", status.index_task_id)
    reopened.close()


def test_neural_target_change_keeps_old_generation_until_rebuild(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, FIRST_ASSET_ID, "检索迁移")
    _save_transcript(library, FIRST_ASSET_ID, [(0, 20, "神经检索旧代际")])
    old_status = library.rebuild_agent_semantic_index(
        model_name=TEST_NEURAL_MODEL,
        model_version="old-revision",
        dimensions=TEST_NEURAL_DIMENSIONS,
        encode_documents=_encode_test_documents,
    )

    changed = library.ensure_agent_semantic_index_target(
        TEST_NEURAL_MODEL,
        TEST_NEURAL_VERSION,
    )
    waiting = library.agent_evidence_index_status()

    assert changed is True
    assert waiting.state == "lexical_ready"
    assert waiting.active_model == old_status.active_model
    library.close()


def test_neural_reranker_controls_final_candidate_order(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, FIRST_ASSET_ID, "重排课程")
    _save_transcript(
        library,
        FIRST_ASSET_ID,
        [
            (0, 20, "透视投影只是本节的背景术语"),
            (20, 40, "透视投影的正式定义和推导过程"),
        ],
    )
    library.rebuild_agent_semantic_index(
        model_name=TEST_NEURAL_MODEL,
        model_version=TEST_NEURAL_VERSION,
        dimensions=TEST_NEURAL_DIMENSIONS,
        encode_documents=_encode_test_documents,
    )

    evidence = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query="透视投影",
        start_seconds=None,
        end_seconds=None,
        limit=2,
        query_encoder=_encode_test_query,
        reranker=lambda query, documents: [
            0.99 if "正式定义" in document else 0.01 for document in documents
        ],
    )

    assert evidence[0].start_seconds == 20
    assert "神经交叉编码重排" in evidence[0].match_reasons
    library.close()


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ("为什么法线贴图需要禁用 sRGB", "法线贴图存储方向，因此应禁用 sRGB。"),
        ("相机 焦距 视场角", "焦距变长会缩小相机的视场角。"),
        ("HTTP 429 Retry-After 怎样处理", "HTTP 429 限流时应遵守 Retry-After。"),
        ("optimizer.zero_grad() 清除什么", "optimizer.zero_grad() 清除梯度。"),
    ],
)
def test_lexical_retrieval_handles_question_word_order_and_identifiers(
    tmp_path: Path, query, expected
):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, FIRST_ASSET_ID, "技术课程")
    _save_asset(library, SECOND_ASSET_ID, "未授权课程")
    _save_transcript(
        library,
        FIRST_ASSET_ID,
        [
            (0, 10, "法线贴图存储方向，因此应禁用 sRGB。"),
            (50, 60, "焦距变长会缩小相机的视场角。"),
            (100, 110, "HTTP 429 限流时应遵守 Retry-After。"),
            (150, 160, "optimizer.zero_grad() 清除梯度。"),
            (200, 210, "HTTP 404 表示页面不存在。"),
            (250, 260, "相机窗口正在显示，字幕文字无法辨认。"),
        ],
    )
    _save_transcript(library, SECOND_ASSET_ID, [(0, 10, query)])

    found = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query=query,
        start_seconds=None,
        end_seconds=None,
        limit=3,
    )

    assert found[0].text == expected
    assert all(item.asset_id == FIRST_ASSET_ID for item in found)
    library.close()


@pytest.mark.parametrize("query", ["%", "_", "\\"])
def test_short_lexical_query_treats_like_metacharacters_literally(
    tmp_path: Path, query
):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, FIRST_ASSET_ID, "字面值")
    _save_transcript(
        library,
        FIRST_ASSET_ID,
        [
            (0, 10, "完全无关的句子"),
            (100, 110, f"运算符 {query} 的含义"),
        ],
    )
    found = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query=query,
        start_seconds=None,
        end_seconds=None,
        limit=3,
    )
    assert [item.text for item in found] == [f"运算符 {query} 的含义"]
    library.close()


def test_lexical_expansion_is_bounded_and_fts_operators_remain_literal(tmp_path: Path):
    terms = agent_evidence_index._lexical_query_terms("关键帧旋转截图" * 200)
    assert len(terms) <= agent_evidence_index.LEXICAL_QUERY_MAX_TERMS
    assert all(
        len(term) <= agent_evidence_index.LEXICAL_QUERY_MAX_CHARACTERS for term in terms
    )
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, FIRST_ASSET_ID, "安全语法")
    _save_transcript(library, FIRST_ASSET_ID, [(0, 10, "关键帧截图")])
    found = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query='" OR NEAR(关键帧) * -',
        start_seconds=None,
        end_seconds=None,
        limit=3,
    )
    assert found[0].text == "关键帧截图"
    library.close()


def test_rrf_fuses_candidate_ranks_without_using_rank_score_as_confidence(
    tmp_path: Path, monkeypatch
):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, FIRST_ASSET_ID, "融合排序")
    _save_transcript(
        library,
        FIRST_ASSET_ID,
        [
            (0, 10, "词法独占候选"),
            (100, 110, "两个检索器均认可的候选"),
            (200, 210, "语义独占候选"),
        ],
    )
    rows = (
        library._db()
        .execute("SELECT * FROM agent_evidence_documents ORDER BY start_seconds")
        .fetchall()
    )
    monkeypatch.setattr(
        agent_evidence_index, "_lexical_matches", lambda *_args: rows[:2]
    )
    monkeypatch.setattr(
        agent_evidence_index,
        "_semantic_matches",
        lambda *_args: [
            (rows[2], 0.99, "neural"),
            (rows[1], 0.01, "neural"),
        ],
    )
    rerank_inputs = []

    def equal_rerank(_query, documents):
        rerank_inputs.extend(documents)
        return [0.6] * len(documents)

    found = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query="一个问题",
        start_seconds=None,
        end_seconds=None,
        limit=2,
        reranker=equal_rerank,
    )
    assert rerank_inputs[0].endswith("两个检索器均认可的候选")
    assert found[0].text == "两个检索器均认可的候选"
    assert all(item.relevance_score == 0.6 for item in found)
    library.close()


def test_reranker_relevance_cannot_be_overruled_by_keyword_bonus(
    tmp_path: Path, monkeypatch
):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, FIRST_ASSET_ID, "相关性")
    _save_transcript(
        library,
        FIRST_ASSET_ID,
        [
            (0, 10, "递归只是本课的一个背景词"),
            (100, 110, "把问题拆成更小的同类问题，直到满足终止条件"),
        ],
    )
    rows = (
        library._db()
        .execute("SELECT * FROM agent_evidence_documents ORDER BY start_seconds")
        .fetchall()
    )
    monkeypatch.setattr(
        agent_evidence_index, "_lexical_matches", lambda *_args: rows[:1]
    )
    monkeypatch.setattr(
        agent_evidence_index,
        "_semantic_matches",
        lambda *_args: [
            (rows[1], 0.95, "neural"),
        ],
    )
    found = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query="递归",
        start_seconds=None,
        end_seconds=None,
        limit=2,
        reranker=lambda _query, documents: [
            0.4 if "背景词" in text else 0.55 for text in documents
        ],
    )
    assert found[0].start_seconds == 100
    assert found[0].relevance_score == 0.55
    library.close()


@pytest.mark.parametrize("score", [float("nan"), float("inf"), -float("inf")])
def test_reranker_rejects_nonfinite_confidence(tmp_path: Path, score):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, FIRST_ASSET_ID, "评分校验")
    _save_transcript(library, FIRST_ASSET_ID, [(0, 10, "正确的关键词")])
    with pytest.raises(ValueError, match="非有限"):
        library.search_agent_evidence(
            asset_ids=[FIRST_ASSET_ID],
            query="关键词",
            start_seconds=None,
            end_seconds=None,
            limit=1,
            reranker=lambda _query, documents: [score] * len(documents),
        )
    library.close()


def test_diversity_does_not_promote_irrelevant_asset_or_duplicate_content(
    tmp_path: Path,
):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, FIRST_ASSET_ID, "相机课程")
    _save_asset(library, SECOND_ASSET_ID, "无关课程")
    _save_transcript(
        library,
        FIRST_ASSET_ID,
        [
            (0, 10, "相机透视投影让远处物体看起来更小"),
            (100, 110, "相机透视投影让远处物体看起来更小"),
            (200, 210, "相机透视投影需要除以深度坐标 z"),
        ],
    )
    library.save_segments(
        SECOND_ASSET_ID,
        [
            MediaSegment(
                segment_id=f"segment-{SECOND_ASSET_ID.replace('-', '')}",
                asset_id=SECOND_ASSET_ID,
                start_seconds=0,
                end_seconds=10,
                ocr_text="菜单显示相机透视投影几个字",
            )
        ],
    )
    found = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID, SECOND_ASSET_ID],
        query="相机透视投影",
        start_seconds=None,
        end_seconds=None,
        limit=2,
        reranker=lambda _query, documents: [
            0.05 if "菜单" in text else 0.9 for text in documents
        ],
    )
    assert all(item.asset_id == FIRST_ASSET_ID for item in found)
    assert [item.start_seconds for item in found] == [0, 200]
    library.close()


def test_neighbors_follow_time_within_the_same_source_family(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, FIRST_ASSET_ID, "相邻上下文")
    _save_transcript(
        library,
        FIRST_ASSET_ID,
        [
            (100, 102, "主线独特锚点"),
            (102, 104, "真正紧接着的原始字幕"),
            (500, 502, "很远之后的另一主题"),
        ],
    )
    library.save_segments(
        FIRST_ASSET_ID,
        [
            MediaSegment(
                segment_id=f"segment-{FIRST_ASSET_ID.replace('-', '')}",
                asset_id=FIRST_ASSET_ID,
                start_seconds=99,
                end_seconds=100,
                transcript_text="章节整理版字幕，不是原始字幕邻居",
            )
        ],
    )
    found = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query="主线独特锚点",
        start_seconds=None,
        end_seconds=None,
        limit=4,
    )
    assert [item.start_seconds for item in found] == [100, 102]
    assert found[1].retrieval_relation == "neighbor"
    library.close()


def test_direct_evidence_keeps_budget_before_unmatched_neighbors(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, FIRST_ASSET_ID, "直接依据")
    _save_transcript(
        library,
        FIRST_ASSET_ID,
        [
            (0, 10, "纯粹的前导语"),
            (10, 20, "透视投影第一条依据"),
            (20, 30, "无关的过渡句"),
            (100, 110, "透视投影第二条依据"),
            (200, 210, "透视投影第三条依据"),
        ],
    )
    found = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query="透视投影",
        start_seconds=None,
        end_seconds=None,
        limit=3,
    )
    assert len(found) == 3
    assert all(item.retrieval_relation == "direct" for item in found)
    assert all("依据" in item.text for item in found)
    library.close()


def test_verified_memory_locates_evidence_and_invalidates_with_its_source(
    tmp_path: Path,
):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, FIRST_ASSET_ID, "项目复盘")
    _save_transcript(
        library,
        FIRST_ASSET_ID,
        [(10, 30, "团队决定在九月发布产品")],
    )
    source = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query="九月发布",
        start_seconds=None,
        end_seconds=None,
        limit=4,
    )[0]
    memory_id = library.save_agent_verified_memory(
        asset_id=FIRST_ASSET_ID,
        fact_type="project_code_name",
        fact="项目代号：猎鹰计划",
        source_version=source.source_version,
    )

    recalled = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query="猎鹰计划",
        start_seconds=None,
        end_seconds=None,
        limit=4,
    )

    assert recalled
    assert "已验证项目记忆定位" in recalled[0].match_reasons

    _save_transcript(
        library,
        FIRST_ASSET_ID,
        [(10, 30, "团队尚未确定产品发布时间")],
    )
    valid = (
        library._db()
        .execute(
            "SELECT valid FROM agent_verified_memories WHERE memory_id = ?",
            (memory_id,),
        )
        .fetchone()[0]
    )
    invalidated_recall = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query="猎鹰计划",
        start_seconds=None,
        end_seconds=None,
        limit=4,
    )

    assert valid == 0
    assert invalidated_recall == []
    library.close()
