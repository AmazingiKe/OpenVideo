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
