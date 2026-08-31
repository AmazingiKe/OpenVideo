from openvideo.core.analysis import SemanticChapter
from openvideo.core.transcription_models import TranscriptSegment
from openvideo.tools import chapters


def test_internal_window_starts_do_not_become_final_chapter_boundaries(monkeypatch):
    monkeypatch.setattr(chapters, "CHAPTER_WINDOW_MAX_CHARACTERS", 10)
    monkeypatch.setattr(chapters, "CHAPTER_WINDOW_OVERLAP_SEGMENTS", 2)
    segments = [
        TranscriptSegment(
            start_seconds=index,
            end_seconds=index + 0.5,
            text="四字文本",
        )
        for index in range(6)
    ]

    def analyze_window(window, offset):
        candidates = [
            SemanticChapter(
                start_index=offset,
                end_index=offset + len(window) - 1,
                title="窗口起点",
            )
        ]
        if offset <= 3 < offset + len(window):
            candidates.append(
                SemanticChapter(
                    start_index=3,
                    end_index=offset + len(window) - 1,
                    title="真实转折",
                )
            )
        return candidates

    result = chapters.build_global_semantic_chapters(
        segments,
        analyzer=analyze_window,
    )

    assert [(chapter.start_index, chapter.end_index) for chapter in result] == [
        (0, 2),
        (3, 5),
    ]
    assert result[1].title == "真实转折"


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
