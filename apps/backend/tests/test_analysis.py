import pytest

from openvideo.core.analysis import select_timeline_moments
from openvideo.core.analysis_models import (
    AnalysisDepth,
    AnalysisMode,
    AnalysisStrategy,
    AnalysisStrategyPreset,
    AnalysisWeights,
)
from openvideo.core.media_models import MediaMarker
from openvideo.core.transcription_models import Transcript, TranscriptSegment


ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"


def test_full_timeline_splits_on_long_speech_gap():
    transcript = Transcript(
        asset_id=ASSET_ID,
        segments=[
            TranscriptSegment(start_seconds=0, end_seconds=5, text="第一部分"),
            TranscriptSegment(start_seconds=20, end_seconds=25, text="第二部分"),
        ],
    )

    moments = select_timeline_moments(transcript, AnalysisMode.FULL, [], 30)

    assert [(moment.start_seconds, moment.end_seconds) for moment in moments] == [
        (0, 5),
        (20, 25),
    ]


def test_marker_timeline_snaps_to_transcript_and_preserves_tags():
    transcript = Transcript(
        asset_id=ASSET_ID,
        segments=[
            TranscriptSegment(start_seconds=10, end_seconds=20, text="公式定义"),
            TranscriptSegment(start_seconds=25, end_seconds=40, text="推导过程"),
        ],
    )
    marker = MediaMarker(
        marker_id="marker-0123456789abcdef0123456789abcdef",
        asset_id=ASSET_ID,
        start_seconds=30,
        tags=["公式"],
    )

    moments = select_timeline_moments(transcript, AnalysisMode.MARKERS, [marker], 60)

    assert len(moments) == 1
    assert moments[0].start_seconds == 10
    assert moments[0].end_seconds == 40
    assert moments[0].tags == ("公式",)
    assert "公式定义" in moments[0].transcript_text
    assert "推导过程" in moments[0].transcript_text


def test_marker_mode_keeps_overlapping_fallback_ranges_separate():
    transcript = Transcript(asset_id=ASSET_ID)
    markers = [
        MediaMarker(
            marker_id="marker-0123456789abcdef0123456789abcdef",
            asset_id=ASSET_ID,
            start_seconds=30,
            tags=["重点"],
        ),
        MediaMarker(
            marker_id="marker-1123456789abcdef0123456789abcdef",
            asset_id=ASSET_ID,
            start_seconds=50,
            tags=["疑问"],
        ),
    ]

    moments = select_timeline_moments(transcript, AnalysisMode.MARKERS, markers, 120)

    assert [(moment.start_seconds, moment.end_seconds) for moment in moments] == [
        (20, 50),
        (40, 70),
    ]


def test_scene_boundaries_do_not_change_marker_weight_range():
    transcript = Transcript(asset_id=ASSET_ID)
    marker = MediaMarker(
        marker_id="marker-0123456789abcdef0123456789abcdef",
        asset_id=ASSET_ID,
        start_seconds=60,
        tags=["案例"],
    )

    moments = select_timeline_moments(
        transcript,
        AnalysisMode.MARKERS,
        [marker],
        120,
        scene_boundaries=[45, 72],
    )

    assert moments[0].start_seconds == 50
    assert moments[0].end_seconds == 80


def test_full_timeline_returns_empty_for_no_transcript():
    transcript = Transcript(asset_id=ASSET_ID)

    assert select_timeline_moments(transcript, AnalysisMode.FULL, [], None) == []


def test_quick_strategy_keeps_marked_moment_in_detailed_analysis():
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
    marker = MediaMarker(
        marker_id="marker-0123456789abcdef0123456789abcdef",
        asset_id=ASSET_ID,
        start_seconds=82,
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
        AnalysisMode.FULL,
        [marker],
        100,
        strategy=strategy,
    )

    assert len([moment for moment in moments if moment.detailed]) == 3
    assert next(moment for moment in moments if moment.marker_ids).detailed is True


def test_strategy_controls_asymmetric_marker_range():
    transcript = Transcript(asset_id=ASSET_ID, segments=[])
    marker = MediaMarker(
        marker_id="marker-0123456789abcdef0123456789abcdef",
        asset_id=ASSET_ID,
        start_seconds=50,
    )
    strategy = AnalysisStrategy(
        marker_range_before_seconds=15,
        marker_range_after_seconds=25,
    )

    moment = select_timeline_moments(
        transcript,
        AnalysisMode.MARKERS,
        [marker],
        100,
        strategy=strategy,
    )[0]

    assert moment.start_seconds == 35
    assert moment.end_seconds == 75


def test_range_marker_uses_its_exact_bounds():
    transcript = Transcript(asset_id=ASSET_ID)
    marker = MediaMarker(
        marker_id="marker-0123456789abcdef0123456789abcdef",
        asset_id=ASSET_ID,
        start_seconds=5,
        end_seconds=15,
        marker_range_before_seconds=0,
        marker_range_after_seconds=0,
    )

    moment = select_timeline_moments(
        transcript,
        AnalysisMode.MARKERS,
        [marker],
        15,
    )[0]

    assert (moment.start_seconds, moment.end_seconds) == (5, 15)
    assert moment.marker_influences[0].range_before_seconds == 0
    assert moment.marker_influences[0].range_after_seconds == 0


def test_range_marker_inherits_tails_and_clips_them_to_video_bounds():
    marker = MediaMarker(
        marker_id="marker-0123456789abcdef0123456789abcdef",
        asset_id=ASSET_ID,
        start_seconds=5,
        end_seconds=15,
    )

    moment = select_timeline_moments(
        Transcript(asset_id=ASSET_ID),
        AnalysisMode.MARKERS,
        [marker],
        30,
    )[0]

    assert (moment.start_seconds, moment.end_seconds) == (0, 30)
    influence = moment.marker_influences[0]
    assert influence.range_before_seconds == 5
    assert influence.range_after_seconds == 15


def test_marker_overrides_one_side_and_inherits_the_other():
    marker = MediaMarker(
        marker_id="marker-0123456789abcdef0123456789abcdef",
        asset_id=ASSET_ID,
        start_seconds=20,
        marker_range_before_seconds=0,
    )

    moment = select_timeline_moments(
        Transcript(asset_id=ASSET_ID),
        AnalysisMode.MARKERS,
        [marker],
        100,
    )[0]

    assert (moment.start_seconds, moment.end_seconds) == (20, 40)
    assert moment.marker_influences[0].range_before_seconds == 0
    assert moment.marker_influences[0].range_after_seconds == 20


def test_marker_weight_decays_asymmetrically_and_marker_event_is_one():
    transcript = Transcript(
        asset_id=ASSET_ID,
        segments=[
            TranscriptSegment(start_seconds=10, end_seconds=11, text="前侧"),
            TranscriptSegment(start_seconds=20, end_seconds=21, text="标记点"),
            TranscriptSegment(start_seconds=30, end_seconds=31, text="后侧"),
        ],
    )
    marker = MediaMarker(
        marker_id="marker-0123456789abcdef0123456789abcdef",
        asset_id=ASSET_ID,
        start_seconds=20,
    )

    moments = select_timeline_moments(transcript, AnalysisMode.FULL, [marker], 60)

    assert [moment.marker_weight for moment in moments] == pytest.approx([0.1, 1, 0.5])


def test_overlapping_marker_ranges_use_highest_weight_without_accumulating():
    transcript = Transcript(
        asset_id=ASSET_ID,
        segments=[TranscriptSegment(start_seconds=20, end_seconds=21, text="重叠")],
    )
    markers = [
        MediaMarker(
            marker_id="marker-0123456789abcdef0123456789abcdef",
            asset_id=ASSET_ID,
            start_seconds=10,
        ),
        MediaMarker(
            marker_id="marker-1123456789abcdef0123456789abcdef",
            asset_id=ASSET_ID,
            start_seconds=30,
        ),
    ]

    moment = select_timeline_moments(
        transcript,
        AnalysisMode.FULL,
        markers,
        60,
        strategy=AnalysisStrategy(
            marker_range_before_seconds=20,
            marker_range_after_seconds=20,
        ),
    )[0]

    assert [item.event_weight for item in moment.marker_influences] == pytest.approx(
        [0.5, 0.55]
    )
    assert moment.marker_weight == pytest.approx(0.55)


def test_full_mode_preserves_unweighted_events_and_marker_mode_filters_them():
    transcript = Transcript(
        asset_id=ASSET_ID,
        segments=[
            TranscriptSegment(start_seconds=0, end_seconds=1, text="片头"),
            TranscriptSegment(start_seconds=20, end_seconds=21, text="重点"),
            TranscriptSegment(start_seconds=40, end_seconds=41, text="片尾"),
        ],
    )
    marker = MediaMarker(
        marker_id="marker-0123456789abcdef0123456789abcdef",
        asset_id=ASSET_ID,
        start_seconds=20,
    )

    full_moments = select_timeline_moments(
        transcript,
        AnalysisMode.FULL,
        [marker],
        60,
        strategy=AnalysisStrategy(
            marker_range_before_seconds=0,
            marker_range_after_seconds=0,
        ),
    )
    marker_moments = select_timeline_moments(
        transcript,
        AnalysisMode.MARKERS,
        [marker],
        60,
        strategy=AnalysisStrategy(
            marker_range_before_seconds=0,
            marker_range_after_seconds=0,
        ),
    )

    assert len(full_moments) == 3
    assert [moment.transcript_text for moment in marker_moments] == ["重点"]


@pytest.mark.parametrize("value", [-5, 3, 125])
def test_marker_ranges_validate_boundaries_and_five_second_steps(value: int):
    with pytest.raises(ValueError):
        AnalysisStrategy(marker_range_before_seconds=value)
    with pytest.raises(ValueError):
        MediaMarker(
            marker_id="marker-0123456789abcdef0123456789abcdef",
            asset_id=ASSET_ID,
            start_seconds=10,
            marker_range_after_seconds=value,
        )
