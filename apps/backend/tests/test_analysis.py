import pytest

from openvideo.core.analysis import select_timeline_moments
from openvideo.core.analysis_models import (
    AnalysisDepth,
    AnalysisStrategy,
    AnalysisStrategyPreset,
    AnalysisWeights,
)
from openvideo.core.media_models import MediaMarker
from openvideo.core.transcription_models import Transcript, TranscriptSegment


ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"


def marker(start_seconds: float, importance: int = 5) -> MediaMarker:
    return MediaMarker(
        marker_id=f"marker-01890f4c7a2b7cc298c4dc0c0c0739{int(start_seconds):02x}",
        asset_id=ASSET_ID,
        start_seconds=start_seconds,
        importance=importance,
    )


def test_full_timeline_splits_on_long_speech_gap():
    transcript = Transcript(
        asset_id=ASSET_ID,
        segments=[
            TranscriptSegment(start_seconds=0, end_seconds=5, text="第一部分"),
            TranscriptSegment(start_seconds=20, end_seconds=25, text="第二部分"),
        ],
    )

    moments = select_timeline_moments(transcript, [], 30)

    assert [(moment.start_seconds, moment.end_seconds) for moment in moments] == [
        (0, 5),
        (20, 25),
    ]


def test_full_timeline_returns_empty_without_transcript():
    assert select_timeline_moments(Transcript(asset_id=ASSET_ID), [], None) == []


def test_quick_strategy_keeps_marked_moment_detailed():
    transcript = Transcript(
        asset_id=ASSET_ID,
        segments=[
            TranscriptSegment(
                start_seconds=index * 20,
                end_seconds=index * 20 + 5,
                text="公式 x = y" if index < 4 else "普通结尾",
            )
            for index in range(5)
        ],
    )
    strategy = AnalysisStrategy(
        preset=AnalysisStrategyPreset.CUSTOM,
        depth=AnalysisDepth.QUICK,
        weights=AnalysisWeights(
            core_concepts=0,
            formula_derivation=100,
            case_demonstration=0,
            questions_conclusions=0,
            visual_content=0,
            user_markers=0,
        ),
    )

    moments = select_timeline_moments(
        transcript,
        [marker(82)],
        100,
        strategy=strategy,
    )

    assert len([moment for moment in moments if moment.detailed]) == 3
    assert next(moment for moment in moments if moment.marker_ids).detailed is True


def test_point_marker_weight_decays_on_each_side():
    transcript = Transcript(
        asset_id=ASSET_ID,
        segments=[
            TranscriptSegment(start_seconds=10, end_seconds=11, text="前侧"),
            TranscriptSegment(start_seconds=20, end_seconds=21, text="标记点"),
            TranscriptSegment(start_seconds=30, end_seconds=31, text="后侧"),
        ],
    )

    moments = select_timeline_moments(transcript, [marker(20)], 60)

    assert [moment.marker_weight for moment in moments] == pytest.approx(
        [0.1, 1, 0.5]
    )


def test_overlapping_marker_ranges_use_highest_weight():
    transcript = Transcript(
        asset_id=ASSET_ID,
        segments=[TranscriptSegment(start_seconds=20, end_seconds=21, text="重叠")],
    )
    strategy = AnalysisStrategy(
        marker_range_before_seconds=20,
        marker_range_after_seconds=20,
    )

    moment = select_timeline_moments(
        transcript,
        [marker(10), marker(30)],
        60,
        strategy=strategy,
    )[0]

    assert [item.event_weight for item in moment.marker_influences] == pytest.approx(
        [0.5, 0.55]
    )
    assert moment.marker_weight == pytest.approx(0.55)


def test_range_marker_uses_exact_bounds_without_strategy_tails():
    transcript = Transcript(
        asset_id=ASSET_ID,
        segments=[TranscriptSegment(start_seconds=9, end_seconds=10, text="正文")],
    )
    range_marker = marker(5)
    range_marker = range_marker.model_copy(update={"end_seconds": 15})

    moment = select_timeline_moments(transcript, [range_marker], 30)[0]

    influence = moment.marker_influences[0]
    assert influence.focus_start_seconds == 5
    assert influence.focus_end_seconds == 15
    assert influence.range_before_seconds == 0
    assert influence.range_after_seconds == 0


@pytest.mark.parametrize("value", [-5, 3, 125])
def test_strategy_ranges_validate_five_second_steps(value: int):
    with pytest.raises(ValueError):
        AnalysisStrategy(marker_range_before_seconds=value)


@pytest.mark.parametrize(
    ("importance", "expected_weight"),
    [(0, 0), (1, 0.2), (3, 0.6), (5, 1)],
)
def test_marker_importance_scales_weight(
    importance: int,
    expected_weight: float,
):
    transcript = Transcript(
        asset_id=ASSET_ID,
        segments=[TranscriptSegment(start_seconds=10, end_seconds=11, text="正文")],
    )

    moment = select_timeline_moments(
        transcript,
        [marker(10, importance)],
        20,
    )[0]

    assert moment.marker_weight == pytest.approx(expected_weight)


@pytest.mark.parametrize("importance", [-1, 6])
def test_marker_importance_rejects_out_of_range_values(importance: int):
    with pytest.raises(ValueError):
        marker(10, importance)
