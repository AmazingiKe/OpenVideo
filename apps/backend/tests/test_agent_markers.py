import pytest
from pydantic import ValidationError

from openvideo.agent_tooling import (
    MarkerChangeOperation,
    ProposedMarkerChangeInput,
    build_proposed_marker,
)
from openvideo.core.media_models import MediaMarker


ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"


def marker(marker_id: str, importance: int) -> MediaMarker:
    return MediaMarker(
        marker_id=marker_id,
        asset_id=ASSET_ID,
        start_seconds=10,
        importance=importance,
    )


def request(
    operation: MarkerChangeOperation, marker_ids: list[str]
) -> ProposedMarkerChangeInput:
    return ProposedMarkerChangeInput(
        operation=operation,
        marker_ids=marker_ids,
        start_seconds=12,
        reason="测试 Agent 标记重要程度约束",
    )


def test_agent_create_update_and_merge_preserve_user_importance():
    low = marker("marker-0123456789abcdef0123456789abcdef", 2)
    high = marker("marker-1123456789abcdef0123456789abcdef", 5)

    created = build_proposed_marker(
        ASSET_ID, request(MarkerChangeOperation.CREATE, []), []
    )
    updated = build_proposed_marker(
        ASSET_ID,
        request(MarkerChangeOperation.UPDATE, [low.marker_id]),
        [low],
    )
    merged = build_proposed_marker(
        ASSET_ID,
        request(MarkerChangeOperation.MERGE, [low.marker_id, high.marker_id]),
        [low, high],
    )

    assert created is not None and created.importance == 0
    assert updated is not None and updated.importance == 2
    assert merged is not None and merged.importance == 5


def test_agent_cannot_submit_importance():
    with pytest.raises(ValidationError):
        ProposedMarkerChangeInput.model_validate(
            {
                "operation": "create",
                "start_seconds": 10,
                "importance": 5,
                "reason": "不允许 Agent 设置星级",
            }
        )
