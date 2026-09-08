from openvideo.core.transcription_models import TranscriptSegment
from openvideo.tools import chapters


def test_oversized_subtitle_keeps_all_text_and_its_original_index(monkeypatch):
    monkeypatch.setattr(chapters, "CHAPTER_WINDOW_MAX_CHARACTERS", 120)
    source = "同一个主题的解释。" * 50 + "最后的限制条件。"
    segments = [TranscriptSegment(start_seconds=0, end_seconds=30, text=source)]
    evidence = chapters._transcript_evidence(segments, [])
    windows = chapters._evidence_windows(evidence)

    assert len(windows) > 1
    assert all(
        len("\n".join(item.text for item in window)) <= 120 for window in windows
    )
    assert all((item.start_index, item.end_index) == (0, 0) for item in evidence)
    assert (
        "".join(item.text.removeprefix("[0] 0.000-30.000 ") for item in evidence)
        == source
    )


def test_global_chapters_fall_back_to_speech_gaps():
    segments = [
        TranscriptSegment(start_seconds=0, end_seconds=1, text="第一章"),
        TranscriptSegment(start_seconds=12, end_seconds=13, text="第二章"),
    ]

    result = chapters.build_global_semantic_chapters(segments)

    assert [(chapter.start_index, chapter.end_index) for chapter in result] == [
        (0, 0),
        (1, 1),
    ]


def test_local_chapters_use_scene_changes_during_continuous_speech():
    segments = [
        TranscriptSegment(
            start_seconds=index * 20,
            end_seconds=(index + 1) * 20,
            text=f"连续讲解 {index}",
        )
        for index in range(7)
    ]

    result = chapters.build_global_semantic_chapters(
        segments,
        scene_boundaries=[65],
    )

    assert [(chapter.start_index, chapter.end_index) for chapter in result] == [
        (0, 3),
        (4, 6),
    ]


def test_local_chapters_use_short_pause_after_minimum_duration():
    segments = [
        TranscriptSegment(start_seconds=0, end_seconds=30, text="铺垫概念"),
        TranscriptSegment(start_seconds=30, end_seconds=60, text="继续铺垫"),
        TranscriptSegment(start_seconds=62, end_seconds=90, text="新的主题"),
        TranscriptSegment(start_seconds=90, end_seconds=120, text="展开讲解"),
    ]

    result = chapters.build_global_semantic_chapters(segments)

    assert [(chapter.start_index, chapter.end_index) for chapter in result] == [
        (0, 1),
        (2, 3),
    ]


def test_local_chapters_use_explicit_semantic_transition():
    segments = [
        TranscriptSegment(start_seconds=0, end_seconds=30, text="第一部分"),
        TranscriptSegment(start_seconds=30, end_seconds=60, text="继续讲解"),
        TranscriptSegment(start_seconds=60, end_seconds=90, text="接下来讲新主题"),
        TranscriptSegment(start_seconds=90, end_seconds=120, text="展开讲解"),
    ]

    result = chapters.build_global_semantic_chapters(segments)

    assert [(chapter.start_index, chapter.end_index) for chapter in result] == [
        (0, 1),
        (2, 3),
    ]


def test_local_chapters_limit_continuous_chapter_duration():
    segments = [
        TranscriptSegment(
            start_seconds=index * 30,
            end_seconds=(index + 1) * 30,
            text=f"连续讲解 {index}",
        )
        for index in range(13)
    ]

    result = chapters.build_global_semantic_chapters(segments)

    assert [(chapter.start_index, chapter.end_index) for chapter in result] == [
        (0, 9),
        (10, 12),
    ]


def test_local_chapters_do_not_create_a_short_tail_at_maximum_duration():
    segments = [
        TranscriptSegment(
            start_seconds=index * 30,
            end_seconds=(index + 1) * 30,
            text=f"连续讲解 {index}",
        )
        for index in range(11)
    ]

    result = chapters.build_global_semantic_chapters(segments)

    assert [(chapter.start_index, chapter.end_index) for chapter in result] == [
        (0, 10),
    ]
