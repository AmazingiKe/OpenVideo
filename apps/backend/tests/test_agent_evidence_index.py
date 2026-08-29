import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event

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
    first_status = library.rebuild_agent_semantic_index()

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

    rebuilt_status = library.rebuild_agent_semantic_index()
    semantic_result = library.search_agent_evidence(
        asset_ids=[FIRST_ASSET_ID],
        query="量子芯片并行计算",
        start_seconds=None,
        end_seconds=None,
        limit=4,
    )

    assert rebuilt_status.state == "ready"
    assert rebuilt_status.active_model != first_status.active_model
    assert any("语义向量" in reason for reason in semantic_result[0].match_reasons)
    assert (
        library._db()
        .execute("SELECT COUNT(*) FROM agent_semantic_models WHERE active = 1")
        .fetchone()[0]
        == 1
    )
    library.close()


def test_unknown_projection_duration_reports_stage_without_fake_progress(
    tmp_path: Path,
    monkeypatch,
):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, FIRST_ASSET_ID, "索引进度课程")
    _save_transcript(
        library,
        FIRST_ASSET_ID,
        [(0, 20, "真实进度不能用估算百分比替代")],
    )
    projection_started = Event()
    release_projection = Event()
    original_latent_vectors = agent_evidence_index._latent_vectors

    def blocked_latent_vectors(matrix):
        projection_started.set()
        release_projection.wait(timeout=5)
        return original_latent_vectors(matrix)

    monkeypatch.setattr(
        agent_evidence_index,
        "_latent_vectors",
        blocked_latent_vectors,
    )
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(library.rebuild_agent_semantic_index)
            assert projection_started.wait(timeout=5)
            status = library.agent_evidence_index_status()
            coverage = library.agent_evidence_index_coverage(FIRST_ASSET_ID)

            assert status.state == "semantic_building"
            assert status.stage == "projecting"
            assert status.processed_documents == 0
            assert status.total_documents == 0
            assert coverage.covered_seconds == 20
            assert coverage.document_count == 1
            release_projection.set()
            assert future.result(timeout=5).state == "ready"
    finally:
        release_projection.set()
        library.close()


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
