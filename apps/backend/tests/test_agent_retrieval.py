from pydantic import ValidationError
import pytest

from openvideo.agent_retrieval import retrieve_evidence
from openvideo.core.agent_evidence_models import AgentEvidenceItem
from openvideo.core.identifiers import uuid7
from openvideo.core.media_models import MediaSegment
from openvideo.core.transcription_models import TranscriptSegment


ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"


def transcript(start: float, text: str) -> TranscriptSegment:
    return TranscriptSegment(start_seconds=start, end_seconds=start + 20, text=text)


def analysis(start: float, text: str, position: int) -> MediaSegment:
    return MediaSegment(
        segment_id=f"segment-01890f4c7a2b7cc298c4dc0c0c{position:05x}",
        asset_id=ASSET_ID,
        start_seconds=start,
        end_seconds=start + 20,
        title=f"章节 {position}",
        detailed_summary=text,
    )


def test_overview_distributes_evidence_across_a_long_video():
    transcript_segments = [
        transcript(float(position * 100), f"第 {position + 1} 章内容")
        for position in range(8)
    ]
    analysis_segments = [
        analysis(float(position * 100 + 10), f"第 {position + 1} 章分析", position)
        for position in range(8)
    ]

    result = retrieve_evidence(
        asset_id=ASSET_ID,
        query=None,
        start_seconds=None,
        end_seconds=None,
        limit=8,
        duration_seconds=800,
        transcript_segments=transcript_segments,
        analysis_segments=analysis_segments,
    )

    assert len(result.evidence_bundle.items) == 8
    assert result.evidence_bundle.items[0].start_seconds < 100
    assert result.evidence_bundle.items[-1].start_seconds >= 700
    assert result.evidence_bundle.coverage.source_types == ["analysis", "transcript"]
    assert result.evidence_bundle.coverage.temporal >= 0.75
    assert result.confidence == "high"


def test_query_retrieval_does_not_let_transcript_starve_analysis():
    transcript_segments = [
        transcript(float(position * 10), "透视投影展示空间关系")
        for position in range(12)
    ]
    analysis_segments = [analysis(500, "透视投影展示空间关系", 1)]

    result = retrieve_evidence(
        asset_id=ASSET_ID,
        query="透视投影",
        start_seconds=None,
        end_seconds=None,
        limit=4,
        duration_seconds=600,
        transcript_segments=transcript_segments,
        analysis_segments=analysis_segments,
    )

    assert {item.source_type for item in result.evidence_bundle.items} == {
        "analysis",
        "transcript",
    }
    assert any(item.start_seconds == 500 for item in result.evidence_bundle.items)


def test_query_retrieval_keeps_ocr_and_visual_as_independent_sources():
    segment = MediaSegment(
        segment_id=f"segment-{uuid7().hex}",
        asset_id=ASSET_ID,
        start_seconds=100,
        end_seconds=120,
        title="矩阵章节",
        detailed_summary="矩阵决定投影规则",
        transcript_text="讲师解释矩阵乘法",
        visual_description="画面展示矩阵变换示意图",
        ocr_text="板书文字为投影矩阵公式",
    )

    result = retrieve_evidence(
        asset_id=ASSET_ID,
        query="矩阵",
        start_seconds=None,
        end_seconds=None,
        limit=4,
        duration_seconds=300,
        transcript_segments=[],
        analysis_segments=[segment],
    )

    assert result.evidence_bundle.coverage.source_types == [
        "analysis",
        "ocr",
        "transcript",
        "visual",
    ]
    assert {item.source_type for item in result.evidence_bundle.items} == {
        "analysis",
        "ocr",
        "transcript",
        "visual",
    }


def test_query_retrieval_expands_neighbors_for_local_context():
    transcript_segments = [
        transcript(0, "开始介绍相机参数"),
        transcript(20, "核心结论是焦距影响视角"),
        transcript(40, "随后展示调整前后的结果"),
    ]

    result = retrieve_evidence(
        asset_id=ASSET_ID,
        query="焦距影响视角",
        start_seconds=None,
        end_seconds=None,
        limit=3,
        duration_seconds=60,
        transcript_segments=transcript_segments,
        analysis_segments=[],
    )

    assert [item.start_seconds for item in result.evidence_bundle.items] == [20, 0, 40]
    assert result.evidence_bundle.items[1].match_reasons == ["邻近上下文"]


def test_duplicate_cross_source_evidence_is_merged_with_provenance():
    result = retrieve_evidence(
        asset_id=ASSET_ID,
        query="透视投影",
        start_seconds=None,
        end_seconds=None,
        limit=4,
        duration_seconds=60,
        transcript_segments=[transcript(10, "透视投影展示空间关系")],
        analysis_segments=[analysis(10, "透视投影展示空间关系", 2)],
    )

    assert len(result.evidence_bundle.items) == 1
    assert result.evidence_bundle.items[0].source_type == "analysis"
    assert result.evidence_bundle.items[0].supporting_source_types == ["transcript"]
    assert "多源一致" in result.evidence_bundle.items[0].match_reasons
    assert result.evidence_bundle.items[0].relation == "supports"
    assert result.evidence_bundle.items[0].retrieval_relation == "corroborated"
    assert result.confidence == "high"


def test_conflicting_overlapping_sources_force_low_confidence():
    result = retrieve_evidence(
        asset_id=ASSET_ID,
        query="现场人数",
        start_seconds=None,
        end_seconds=None,
        limit=4,
        duration_seconds=60,
        transcript_segments=[transcript(10, "现场人数是 3 人")],
        analysis_segments=[analysis(10, "现场人数是 4 人", 3)],
    )

    assert result.confidence == "low"
    assert len(result.evidence_bundle.conflicts[0].evidence_ids) == 2
    assert {item.relation for item in result.evidence_bundle.items} == {"conflicts"}
    assert "冲突" in result.answer_instruction


def test_conflicting_negation_between_transcript_and_visual_is_low_confidence():
    segment = MediaSegment(
        segment_id=f"segment-{uuid7().hex}",
        asset_id=ASSET_ID,
        start_seconds=10,
        end_seconds=30,
        visual_description="该按钮不可以导出结果",
    )

    result = retrieve_evidence(
        asset_id=ASSET_ID,
        query="按钮导出结果",
        start_seconds=None,
        end_seconds=None,
        limit=4,
        duration_seconds=60,
        transcript_segments=[transcript(10, "该按钮可以导出结果")],
        analysis_segments=[segment],
    )

    assert result.confidence == "low"
    assert "肯定与否定" in result.evidence_bundle.conflicts[0].reason


def test_missing_evidence_is_explicitly_low_confidence():
    result = retrieve_evidence(
        asset_id=ASSET_ID,
        query="视频中不存在的术语",
        start_seconds=None,
        end_seconds=None,
        limit=4,
        duration_seconds=600,
        transcript_segments=[transcript(0, "只介绍了基础概念")],
        analysis_segments=[],
    )

    assert result.evidence_bundle.items == []
    assert result.confidence == "low"
    assert result.confidence_reasons == ["没有找到支持当前问题的证据"]


def test_evidence_item_rejects_an_empty_time_range():
    with pytest.raises(ValidationError):
        AgentEvidenceItem(
            evidence_id=f"evidence-{uuid7().hex}",
            citation_key="E1",
            source_type="transcript",
            source_version="0" * 64,
            asset_id=ASSET_ID,
            start_seconds=10,
            end_seconds=10,
            excerpt="无效范围",
            relation="supports",
            retrieval_relation="direct",
            relevance_score=1,
        )
