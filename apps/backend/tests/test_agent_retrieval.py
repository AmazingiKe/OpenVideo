from pydantic import ValidationError
import pytest

from openvideo.agent_retrieval import retrieve_indexed_evidence
from openvideo.agent_tooling import RunEvidenceState
from openvideo.core.agent_evidence_index import IndexedEvidenceDocument
from openvideo.core.agent_evidence_models import AgentEvidenceItem, AgentEvidenceSource
from openvideo.core.identifiers import uuid7


ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"


def evidence(
    source: AgentEvidenceSource,
    start: float,
    text: str,
    *,
    score: float = 0.8,
) -> IndexedEvidenceDocument:
    return IndexedEvidenceDocument(
        document_id=f"evidence-{uuid7().hex}",
        asset_id=ASSET_ID,
        source_type=source,
        source_version="0" * 64,
        source_position=round(start),
        start_seconds=start,
        end_seconds=start + 20,
        title=None,
        text=text,
        relevance_score=score,
        match_reasons=("测试召回",),
    )


def retrieve(*documents: IndexedEvidenceDocument, query: str):
    return retrieve_indexed_evidence(
        documents=documents,
        query=query,
        start_seconds=None,
        end_seconds=None,
        limit=4,
        duration_seconds=60,
    )


def test_duplicate_cross_source_evidence_is_merged_with_provenance():
    result = retrieve(
        evidence(AgentEvidenceSource.TRANSCRIPT, 10, "透视投影展示空间关系"),
        evidence(AgentEvidenceSource.ANALYSIS, 10, "透视投影展示空间关系"),
        query="透视投影",
    )

    assert len(result.evidence_bundle.items) == 1
    assert result.evidence_bundle.items[0].source_type == "analysis"
    assert result.evidence_bundle.items[0].supporting_source_types == ["transcript"]
    assert "多源一致" in result.evidence_bundle.items[0].match_reasons
    assert result.evidence_bundle.items[0].relation == "supports"
    assert result.evidence_bundle.items[0].retrieval_relation == "corroborated"
    assert result.confidence == "high"


def test_conflicting_overlapping_sources_force_low_confidence():
    result = retrieve(
        evidence(AgentEvidenceSource.TRANSCRIPT, 10, "现场人数是 3 人"),
        evidence(AgentEvidenceSource.ANALYSIS, 10, "现场人数是 4 人"),
        query="现场人数",
    )

    assert result.confidence == "low"
    assert len(result.evidence_bundle.conflicts[0].evidence_ids) == 2
    assert {item.relation for item in result.evidence_bundle.items} == {"conflicts"}
    assert "冲突" in result.answer_instruction


def test_conflicting_negation_between_transcript_and_visual_is_low_confidence():
    result = retrieve(
        evidence(AgentEvidenceSource.TRANSCRIPT, 10, "该按钮可以导出结果"),
        evidence(AgentEvidenceSource.VISUAL, 10, "该按钮不可以导出结果"),
        query="按钮导出结果",
    )

    assert result.confidence == "low"
    assert "肯定与否定" in result.evidence_bundle.conflicts[0].reason


def test_missing_evidence_is_explicitly_low_confidence():
    result = retrieve(query="视频中不存在的术语")

    assert result.evidence_bundle.items == []
    assert result.confidence == "low"
    assert result.confidence_reasons == ["没有找到支持当前问题的证据"]


def test_programmatic_write_decision_blocks_low_and_allows_medium_evidence():
    low_state = RunEvidenceState()
    low_state.record_search(
        retrieve(
            evidence(
                AgentEvidenceSource.TRANSCRIPT,
                10,
                "只有模糊的邻近上下文",
                score=0.08,
            ),
            query="明确结论",
        )
    )
    medium_state = RunEvidenceState()
    medium_state.record_search(
        retrieve(
            evidence(AgentEvidenceSource.TRANSCRIPT, 10, "明确结论", score=0.8),
            query="明确结论",
        )
    )

    low_decision = low_state.write_decision()
    medium_decision = medium_state.write_decision()

    assert low_decision.allowed is False
    assert low_decision.confidence == "low"
    assert medium_decision.allowed is True
    assert medium_decision.confidence == "medium"


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
