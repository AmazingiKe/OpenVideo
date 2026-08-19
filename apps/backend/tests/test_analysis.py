from openvideo.core.analysis import select_key_moments
from openvideo.core.analysis_models import Transcript, TranscriptSegment


def test_selects_bucket_with_important_content():
    transcript = Transcript(
        asset_id="asset-0123456789abcdef0123456789abcdef",
        segments=[
            TranscriptSegment(start_seconds=0, end_seconds=2, text="开场白"),
            TranscriptSegment(start_seconds=35, end_seconds=40, text="这是重点，记住这个公式"),
            TranscriptSegment(start_seconds=41, end_seconds=45, text="核心结论如下"),
        ],
    )

    moments = select_key_moments(transcript, bucket_seconds=30, max_moments=1)

    assert len(moments) == 1
    assert moments[0].start_seconds == 30
    assert "重点" in moments[0].transcript_text


def test_returns_empty_for_no_segments():
    transcript = Transcript(asset_id="asset-0123456789abcdef0123456789abcdef")

    assert select_key_moments(transcript) == []


def test_sorts_moments_by_time():
    transcript = Transcript(
        asset_id="asset-0123456789abcdef0123456789abcdef",
        segments=[
            TranscriptSegment(start_seconds=70, end_seconds=72, text="重点内容"),
            TranscriptSegment(start_seconds=10, end_seconds=12, text="重点内容"),
        ],
    )

    moments = select_key_moments(transcript, bucket_seconds=30, max_moments=5)

    assert [moment.start_seconds for moment in moments] == [0, 60]
