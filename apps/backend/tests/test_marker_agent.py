from pathlib import Path
from uuid import UUID

import pytest

from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.marker_agent_models import (
    MarkerAgentMessageRequest,
    MarkerProposalOperation,
    MarkerProposalStatus,
    MarkerRetrievalMode,
)
from openvideo.core.media_models import (
    MediaAsset,
    MediaAssetStatus,
    MediaMarker,
    MediaSegment,
    SourcePlatform,
)
from openvideo.marker_agent_manager import (
    EvidenceSearchInput,
    InspectFramesInput,
    MarkerAgentError,
    MarkerAgentManager,
    MarkerProposalConflictError,
    MarkerTurnState,
    ProposeMarkerChangesInput,
    ProposedMarkerChangeInput,
)
from openvideo.settings import Settings


ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"
SECOND_ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c073990"


def create_manager(tmp_path: Path) -> tuple[MediaLibrary, MarkerAgentManager]:
    library = MediaLibrary.initialize_directory(tmp_path)
    for asset_id in (ASSET_ID, SECOND_ASSET_ID):
        library.save(
            MediaAsset(
                asset_id=asset_id,
                source_url=f"https://example.com/{asset_id}",
                source_platform=SourcePlatform.YOUTUBE,
                source_video_id=asset_id,
                title="测试视频",
                duration_seconds=60,
                status=MediaAssetStatus.READY,
            )
        )
    return library, MarkerAgentManager(library, Settings(library_path=tmp_path))


def marker(marker_id: str, start_seconds: float, title: str) -> MediaMarker:
    return MediaMarker(
        marker_id=marker_id,
        asset_id=ASSET_ID,
        start_seconds=start_seconds,
        title=title,
    )


def assert_prefixed_uuid7(identifier: str, prefix: str) -> None:
    assert identifier.startswith(prefix)
    parsed = UUID(hex=identifier.removeprefix(prefix))
    assert parsed.version == 7


def test_sessions_are_persisted_and_isolated_by_asset(tmp_path: Path):
    library, manager = create_manager(tmp_path)

    first = manager.create_session(ASSET_ID)
    second = manager.create_session(SECOND_ASSET_ID)

    assert_prefixed_uuid7(first.session.session_id, "session-")
    assert [item.session.session_id for item in manager.sessions(ASSET_ID)] == [
        first.session.session_id
    ]
    assert [item.session.session_id for item in manager.sessions(SECOND_ASSET_ID)] == [
        second.session.session_id
    ]
    library.close()

    reopened = MediaLibrary.open(tmp_path)
    restored = MarkerAgentManager(reopened, Settings(library_path=tmp_path))
    assert restored.session_state(first.session.session_id).asset_id == ASSET_ID
    restored.delete_session(first.session.session_id)
    assert restored.sessions(ASSET_ID) == []
    reopened.close()


def test_retrieval_modes_limit_visual_tools_and_honor_turn_override():
    assert MarkerAgentManager._allowed_tools(MarkerRetrievalMode.TRANSCRIPT) == (
        "search_transcript",
        "read_markers",
        "propose_marker_changes",
    )
    assert "inspect_frames" in MarkerAgentManager._allowed_tools(
        MarkerRetrievalMode.AUTO
    )
    assert (
        MarkerAgentManager._turn_retrieval_mode(
            MarkerRetrievalMode.AUTO, "这一轮只看字幕"
        )
        == MarkerRetrievalMode.TRANSCRIPT
    )
    assert (
        MarkerAgentManager._turn_retrieval_mode(
            MarkerRetrievalMode.TRANSCRIPT, "请检查画面"
        )
        == MarkerRetrievalMode.VISION
    )


def test_auto_requires_text_search_before_vision_and_vision_requires_frames(
    tmp_path: Path,
):
    library, manager = create_manager(tmp_path)
    session_id = manager.create_session(ASSET_ID).session.session_id
    model = AiModelConfiguration(
        model_id=f"model-{uuid7().hex}",
        name="视觉模型",
        litellm_model="openai/test",
        input_modalities=["text", "image"],
    )
    manager._turn_states[session_id] = MarkerTurnState(MarkerRetrievalMode.AUTO)

    blocked = manager._inspect_frames_for_turn(
        session_id,
        ASSET_ID,
        model,
        InspectFramesInput(start_seconds=1, end_seconds=2, question="画面内容"),
    )
    assert blocked == {"ok": False, "error": "智能模式必须先检索转录或已有分析"}
    manager._search_transcript_for_turn(
        session_id, ASSET_ID, EvidenceSearchInput(query="结论")
    )
    assert manager._turn_states[session_id].text_searched is True

    manager._turn_states[session_id] = MarkerTurnState(MarkerRetrievalMode.VISION)
    proposal_result = manager._propose_changes(
        session_id,
        ASSET_ID,
        ProposeMarkerChangesInput(
            changes=[
                ProposedMarkerChangeInput(
                    operation=MarkerProposalOperation.CREATE,
                    start_seconds=5,
                    reason="画面标题出现",
                )
            ]
        ),
    )
    assert proposal_result == {
        "ok": False,
        "error": "画面理解模式必须先检查相关画面",
    }
    library.close()


def test_forced_vision_rejects_text_only_model(tmp_path: Path):
    library, manager = create_manager(tmp_path)
    session = manager.create_session(ASSET_ID)
    model = AiModelConfiguration(
        model_id=f"model-{uuid7().hex}",
        name="文本模型",
        litellm_model="openai/test",
    )
    manager.settings = Settings(library_path=tmp_path, ai_models=[model])

    with pytest.raises(MarkerAgentError, match="不支持图像输入"):
        manager.create_message(
            session.session.session_id,
            MarkerAgentMessageRequest(
                content="请检查画面中的标题",
                ai_model_id=model.model_id,
                retrieval_mode=MarkerRetrievalMode.AUTO,
            ),
        )
    library.close()


def test_accepting_merge_rewrites_event_references_atomically(tmp_path: Path):
    library, manager = create_manager(tmp_path)
    session = manager.create_session(ASSET_ID)
    first = marker(f"marker-{uuid7().hex}", 5, "旧标记一")
    second = marker(f"marker-{uuid7().hex}", 15, "旧标记二")
    library.create_marker(first)
    library.create_marker(second)
    library.save_segments(
        ASSET_ID,
        [
            MediaSegment(
                segment_id=f"segment-{uuid7().hex}",
                asset_id=ASSET_ID,
                start_seconds=0,
                end_seconds=20,
                marker_ids=[first.marker_id, second.marker_id],
            )
        ],
    )
    result = manager._propose_changes(
        session.session.session_id,
        ASSET_ID,
        ProposeMarkerChangesInput(
            changes=[
                ProposedMarkerChangeInput(
                    operation=MarkerProposalOperation.MERGE,
                    marker_ids=[first.marker_id, second.marker_id],
                    start_seconds=5,
                    end_seconds=20,
                    title="合并标记",
                    tags=["重点"],
                    reason="两个标记描述同一段内容",
                    evidence=["00:05-00:20 转录连续"],
                )
            ]
        ),
    )
    proposal = result["proposal"]
    assert isinstance(proposal, dict)
    proposal_id = str(proposal["proposal_id"])
    assert_prefixed_uuid7(proposal_id, "proposal-")
    proposed_marker_id = str(proposal["changes"][0]["after"]["marker_id"])
    assert_prefixed_uuid7(proposed_marker_id, "marker-")

    accepted = manager.accept_proposal(proposal_id)

    assert accepted.status == MarkerProposalStatus.ACCEPTED
    assert [item.marker_id for item in library.load_markers(ASSET_ID)] == [
        proposed_marker_id
    ]
    assert library.load_segments(ASSET_ID)[0].marker_ids == [proposed_marker_id]
    library.close()


def test_conflict_marks_the_whole_batch_stale_without_partial_changes(tmp_path: Path):
    library, manager = create_manager(tmp_path)
    session = manager.create_session(ASSET_ID)
    original = marker(f"marker-{uuid7().hex}", 10, "原标题")
    library.create_marker(original)
    result = manager._propose_changes(
        session.session.session_id,
        ASSET_ID,
        ProposeMarkerChangesInput(
            changes=[
                ProposedMarkerChangeInput(
                    operation=MarkerProposalOperation.UPDATE,
                    marker_ids=[original.marker_id],
                    start_seconds=12,
                    title="建议标题",
                    reason="修正定位",
                ),
                ProposedMarkerChangeInput(
                    operation=MarkerProposalOperation.CREATE,
                    start_seconds=30,
                    title="新标记",
                    reason="发现新章节",
                ),
            ]
        ),
    )
    proposal = result["proposal"]
    assert isinstance(proposal, dict)
    proposal_id = str(proposal["proposal_id"])
    library.update_marker(
        ASSET_ID,
        original.marker_id,
        start_seconds=10,
        end_seconds=None,
        title="用户已修改",
        tags=[],
    )

    with pytest.raises(MarkerProposalConflictError):
        manager.accept_proposal(proposal_id)

    assert manager._require_proposal(proposal_id).status == MarkerProposalStatus.STALE
    markers = library.load_markers(ASSET_ID)
    assert len(markers) == 1
    assert markers[0].title == "用户已修改"
    library.close()


def test_rejecting_a_proposal_is_idempotent(tmp_path: Path):
    library, manager = create_manager(tmp_path)
    session = manager.create_session(ASSET_ID)
    result = manager._propose_changes(
        session.session.session_id,
        ASSET_ID,
        ProposeMarkerChangesInput(
            changes=[
                ProposedMarkerChangeInput(
                    operation=MarkerProposalOperation.CREATE,
                    start_seconds=3,
                    title="候选",
                    reason="发现开场定义",
                )
            ]
        ),
    )
    proposal = result["proposal"]
    assert isinstance(proposal, dict)
    proposal_id = str(proposal["proposal_id"])

    assert manager.reject_proposal(proposal_id).status == MarkerProposalStatus.REJECTED
    assert manager.reject_proposal(proposal_id).status == MarkerProposalStatus.REJECTED
    assert library.load_markers(ASSET_ID) == []
    library.close()
