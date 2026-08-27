"""先分析完整字幕语义，再把超长输入的窗口候选归并为最终章节。"""

from __future__ import annotations

import json
from collections.abc import Callable

from openvideo.core.analysis import (
    SPEECH_GAP_SECONDS,
    SemanticChapter,
    merge_semantic_chapter_candidates,
)
from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.transcription_models import TranscriptSegment
from openvideo.tools.llm import LlmCompletionError, complete_text


CHAPTER_WINDOW_MAX_CHARACTERS = 16_000
CHAPTER_WINDOW_OVERLAP_SEGMENTS = 6
CHAPTER_TIMEOUT_SECONDS = 120
CHAPTER_MAX_TOKENS = 4_000
ChapterAnalyzer = Callable[[list[TranscriptSegment], int], list[SemanticChapter]]


def build_global_semantic_chapters(
    segments: list[TranscriptSegment],
    model: AiModelConfiguration | None = None,
    analyzer: ChapterAnalyzer | None = None,
) -> list[SemanticChapter]:
    """时间窗口只约束模型输入，最终边界始终由全局字幕索引重新生成。"""

    if not segments:
        return []
    resolved_analyzer = analyzer
    if resolved_analyzer is None and model is not None:

        def analyze_with_model(
            window: list[TranscriptSegment], offset: int
        ) -> list[SemanticChapter]:
            return _analyze_window(model, window, offset)

        resolved_analyzer = analyze_with_model
    if resolved_analyzer is None:
        return _fallback_chapters(segments)
    candidates: list[SemanticChapter] = []
    for start, end in _overlapping_windows(segments):
        try:
            window_candidates = resolved_analyzer(segments[start:end], start)
        except LlmCompletionError:
            return _fallback_chapters(segments)
        candidates.extend(
            chapter
            for chapter in window_candidates
            if start == 0 or chapter.start_index != start
        )
    if not candidates:
        return _fallback_chapters(segments)
    return merge_semantic_chapter_candidates(len(segments), candidates)


def _overlapping_windows(
    segments: list[TranscriptSegment],
) -> list[tuple[int, int]]:
    windows: list[tuple[int, int]] = []
    start = 0
    while start < len(segments):
        end = start
        characters = 0
        while end < len(segments):
            next_characters = characters + len(segments[end].text)
            if end > start and next_characters > CHAPTER_WINDOW_MAX_CHARACTERS:
                break
            characters = next_characters
            end += 1
        windows.append((start, end))
        if end >= len(segments):
            break
        start = max(start + 1, end - CHAPTER_WINDOW_OVERLAP_SEGMENTS)
    return windows


def _analyze_window(
    model: AiModelConfiguration,
    segments: list[TranscriptSegment],
    offset: int,
) -> list[SemanticChapter]:
    transcript = "\n".join(
        f"[{offset + index}] {segment.start_seconds:.3f}-{segment.end_seconds:.3f} {segment.text}"
        for index, segment in enumerate(segments)
    )
    content = complete_text(
        model,
        [
            {
                "role": "user",
                "content": (
                    "根据以下带全局索引的连续字幕识别主题章节。边界必须位于语义转折，"
                    "不要按固定时长切分。窗口首尾可能与相邻窗口重叠，只返回本窗口内有明确证据的章节。"
                    '严格返回 JSON：{"chapters":[{"start_index":整数,'
                    '"end_index":整数,"title":"简短标题"}]}。\n\n' + transcript
                ),
            }
        ],
        CHAPTER_TIMEOUT_SECONDS,
        max_tokens=CHAPTER_MAX_TOKENS,
        disable_thinking=True,
    )
    return _parse_chapters(content, offset, offset + len(segments) - 1)


def _parse_chapters(
    content: str, minimum_index: int, maximum_index: int
) -> list[SemanticChapter]:
    normalized = content.strip()
    if normalized.startswith("```"):
        normalized = normalized.removeprefix("```json").removeprefix("```")
        normalized = normalized.removesuffix("```").strip()
    try:
        raw_chapters = json.loads(normalized)["chapters"]
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        raise LlmCompletionError("章节模型返回格式无效") from error
    chapters: list[SemanticChapter] = []
    for raw in raw_chapters if isinstance(raw_chapters, list) else []:
        try:
            chapter = SemanticChapter(
                start_index=int(raw["start_index"]),
                end_index=int(raw["end_index"]),
                title=str(raw.get("title", "")).strip(),
            )
        except (KeyError, TypeError, ValueError):
            continue
        if minimum_index <= chapter.start_index <= chapter.end_index <= maximum_index:
            chapters.append(chapter)
    return chapters


def _fallback_chapters(segments: list[TranscriptSegment]) -> list[SemanticChapter]:
    starts = [0]
    for index in range(1, len(segments)):
        previous = segments[index - 1]
        current = segments[index]
        if current.start_seconds - previous.end_seconds >= SPEECH_GAP_SECONDS:
            starts.append(index)
    candidates = [
        SemanticChapter(start_index=start, end_index=len(segments) - 1)
        for start in starts
    ]
    return merge_semantic_chapter_candidates(len(segments), candidates)
