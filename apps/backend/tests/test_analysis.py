from openvideo.core.analysis import select_timeline_moments
from openvideo.core.analysis_models import AnalysisMode, Transcript, TranscriptSegment
from openvideo.core.models import MediaMarker


ASSET_ID = "asset-0123456789abcdef0123456789abcdef"


def test_full_timeline_splits_on_long_speech_gap():
    transcript = Transcript(
        asset_id=ASSET_ID,
        segments=[
            TranscriptSegment(start_seconds=0, end_seconds=5, text="第一部分"),
            TranscriptSegment(start_seconds=20, end_seconds=25, text="第二部分"),
        ],
    )

    moments = select_timeline_moments(transcript, AnalysisMode.FULL, [], 30)

    assert [(moment.start_seconds, moment.end_seconds) for moment in moments] == [(0, 5), (20, 25)]


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
        time_seconds=30,
        tags=["公式"],
    )

    moments = select_timeline_moments(transcript, AnalysisMode.MARKERS, [marker], 60)

    assert len(moments) == 1
    assert moments[0].start_seconds == 10
    assert moments[0].end_seconds == 40
    assert moments[0].tags == ("公式",)
    assert "推导过程" in moments[0].transcript_text


def test_overlapping_marker_windows_merge_into_one_event():
    transcript = Transcript(asset_id=ASSET_ID)
    markers = [
        MediaMarker(
            marker_id="marker-0123456789abcdef0123456789abcdef",
            asset_id=ASSET_ID,
            time_seconds=30,
            tags=["重点"],
        ),
        MediaMarker(
            marker_id="marker-1123456789abcdef0123456789abcdef",
            asset_id=ASSET_ID,
            time_seconds=50,
            tags=["疑问"],
        ),
    ]

    moments = select_timeline_moments(transcript, AnalysisMode.MARKERS, markers, 120)

    assert len(moments) == 1
    assert moments[0].start_seconds == 0
    assert moments[0].end_seconds == 80
    assert moments[0].tags == ("重点", "疑问")


def test_marker_window_snaps_to_nearby_scene_boundaries():
    transcript = Transcript(asset_id=ASSET_ID)
    marker = MediaMarker(
        marker_id="marker-0123456789abcdef0123456789abcdef",
        asset_id=ASSET_ID,
        time_seconds=60,
        tags=["案例"],
    )

    moments = select_timeline_moments(
        transcript,
        AnalysisMode.MARKERS,
        [marker],
        120,
        scene_boundaries=[45, 72],
    )

    assert moments[0].start_seconds == 45
    assert moments[0].end_seconds == 72


def test_full_timeline_returns_empty_for_no_transcript():
    transcript = Transcript(asset_id=ASSET_ID)

    assert select_timeline_moments(transcript, AnalysisMode.FULL, [], None) == []
