"""先分析完整字幕语义，再把超长输入的窗口候选归并为最终章节。"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    ValidationError,
)

from openvideo.core.analysis import (
    SemanticChapter,
    build_local_chapters,
    merge_semantic_chapter_candidates,
)
from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.transcription_models import TranscriptSegment
from openvideo.tools.llm import LlmCompletionError, complete_text


CHAPTER_WINDOW_MAX_CHARACTERS = 16_000
CHAPTER_WINDOW_OVERLAP_SEGMENTS = 6
CHAPTER_TIMEOUT_SECONDS = 120
CHAPTER_MAX_TOKENS = 4_000
CHAPTER_SUMMARY_MAX_CHARACTERS = 400
CHAPTER_SUMMARY_INPUT_CHARACTERS = 12_000
CHAPTER_BOUNDARY_CONTEXT_SEGMENTS = 3
CHAPTER_BOUNDARY_MAX_TOKENS = 512
CHAPTER_SUMMARY_MAX_TOKENS = 1_000
ChapterAnalyzer = Callable[[list[TranscriptSegment], int], list[SemanticChapter]]


@dataclass(frozen=True)
class ChapterVisualEvidence:
    """稀疏画面观察保留取样时间，避免把整片 OCR 错归到某个章节。"""

    seconds: float
    text: str


class ChapterPrediction(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    start_index: StrictInt = Field(ge=0)
    end_index: StrictInt = Field(ge=0)
    title: str = Field(min_length=1, max_length=80)


class ChapterPredictions(BaseModel):
    chapters: list[ChapterPrediction] = Field(min_length=1)


class ChapterSummary(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    summary: str = Field(min_length=1, max_length=CHAPTER_SUMMARY_MAX_CHARACTERS)


def build_global_semantic_chapters(
    segments: list[TranscriptSegment],
    model: AiModelConfiguration | None = None,
    analyzer: ChapterAnalyzer | None = None,
    scene_boundaries: list[float] | None = None,
    visual_evidence: list[ChapterVisualEvidence] | None = None,
) -> list[SemanticChapter]:
    """时间窗口只约束模型输入，最终边界始终由全局字幕索引重新生成。"""

    if not segments:
        return []
    resolved_analyzer = analyzer
    if resolved_analyzer is None and model is not None:

        def analyze_with_model(
            window: list[TranscriptSegment], offset: int
        ) -> list[SemanticChapter]:
            return _analyze_window(model, window, offset, visual_evidence or [])

        resolved_analyzer = analyze_with_model
    if resolved_analyzer is None:
        return build_local_chapters(segments, scene_boundaries)
    candidates: list[SemanticChapter] = []
    windows = _overlapping_windows(segments)
    for start, end in windows:
        window_candidates = resolved_analyzer(segments[start:end], start)
        candidates.extend(
            chapter
            for chapter in window_candidates
            if start == 0 or chapter.start_index != start
        )
    if not candidates and model is not None:
        raise LlmCompletionError("未生成有效章节，请重试或更换模型")
    if not candidates:
        return build_local_chapters(segments, scene_boundaries)
    chapters = merge_semantic_chapter_candidates(len(segments), candidates)
    if model is not None and len(windows) > 1:
        chapters = _reconcile_boundaries(model, segments, chapters)
    return chapters


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
    visual_evidence: list[ChapterVisualEvidence],
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
                    "你在为视频建立便于导航的主题目录。通读全部证据，联合预测章节边界和简短中文主题标题。"
                    "只有主要主题、讲解目标或完整操作阶段改变时才分章；镜头切换、停顿、举例和一句话结束不等于章节。"
                    "不要按固定时长或固定数量切分，不要在一个论证、定义或示例中间分章。"
                    "标题概括本章独有的主题，避免开场口语、字幕摘抄以及空泛的第几部分。"
                    "边界必须引用字幕的全局整数索引，end_index 包含该条字幕。章节连续、互不重叠，覆盖当前输入的每一条字幕。"
                    "画面观察仅是带时间的辅助证据，OCR 可能有误；不得把不同时间的画面混为一章。"
                    '严格返回 JSON：{"chapters":[{"start_index":整数,'
                    '"end_index":整数,"title":"简短标题"}]}。\n\n字幕：\n'
                    + transcript
                    + "\n画面观察：\n"
                    + "\n".join(
                        f"{evidence.seconds:.3f} 秒：{evidence.text}"
                        for evidence in visual_evidence
                        if segments[0].start_seconds
                        <= evidence.seconds
                        <= segments[-1].end_seconds
                    )
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
    normalized = _json_content(content)
    try:
        predictions = ChapterPredictions.model_validate_json(normalized)
    except ValidationError as error:
        raise LlmCompletionError("章节模型返回格式无效") from error
    chapters: list[SemanticChapter] = []
    expected_start = minimum_index
    for raw in predictions.chapters:
        if (
            raw.start_index != expected_start
            or not raw.start_index <= raw.end_index <= maximum_index
            or not raw.title.strip()
        ):
            raise LlmCompletionError("章节边界存在遗漏、重叠或越界")
        chapters.append(
            SemanticChapter(raw.start_index, raw.end_index, raw.title.strip())
        )
        expected_start = raw.end_index + 1
    if expected_start != maximum_index + 1:
        raise LlmCompletionError("章节未覆盖完整字幕")
    return chapters


def _reconcile_boundaries(
    model: AiModelConfiguration,
    segments: list[TranscriptSegment],
    chapters: list[SemanticChapter],
) -> list[SemanticChapter]:
    """窗口接缝仅为计算边界；用相邻两侧的原文审核是否确有主题变化。"""
    accepted = [chapters[0]]
    for chapter in chapters[1:]:
        boundary = chapter.start_index
        left = segments[
            max(
                accepted[-1].start_index, boundary - CHAPTER_BOUNDARY_CONTEXT_SEGMENTS
            ) : boundary
        ]
        right = segments[
            boundary : min(
                chapter.end_index + 1, boundary + CHAPTER_BOUNDARY_CONTEXT_SEGMENTS
            )
        ]
        prompt = (
            "审核两个相邻章节之间是否存在主要主题转折。镜头、停顿、举例以及输入窗口边缘均不足以分章。"
            "若仍是同一概念或步骤的解释，应合并并给出覆盖二者的中文标题。"
            '返回 JSON：{"separate":true或false,"title":"合并后的标题"}。'
            f"\n前章：{accepted[-1].title}\n"
            + "\n".join(item.text for item in left)
            + f"\n后章：{chapter.title}\n"
            + "\n".join(item.text for item in right)
        )
        response = complete_text(
            model,
            [{"role": "user", "content": prompt}],
            CHAPTER_TIMEOUT_SECONDS,
            max_tokens=CHAPTER_BOUNDARY_MAX_TOKENS,
            disable_thinking=True,
        )
        try:
            decision = ChapterBoundaryDecision.model_validate_json(
                _json_content(response)
            )
        except ValidationError as error:
            raise LlmCompletionError("章节接缝校验失败") from error
        if decision.separate:
            accepted.append(chapter)
        else:
            previous = accepted.pop()
            accepted.append(
                SemanticChapter(previous.start_index, chapter.end_index, decision.title)
            )
    return accepted


class ChapterBoundaryDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    separate: StrictBool
    title: str = Field(min_length=1, max_length=80)


def summarize_chapter(
    model: AiModelConfiguration,
    title: str,
    transcript: str,
    ocr_text: str | None,
    visual_description: str | None,
) -> str:
    """只总结最终章节范围内的证据，长章逐块压缩，避免丢掉后半段结论。"""
    evidence = f"字幕：\n{transcript}\n画面文字（可能含识别错误）：\n{ocr_text or ''}\n画面观察：\n{visual_description or ''}"
    while len(evidence) > CHAPTER_SUMMARY_INPUT_CHARACTERS:
        parts = [
            evidence[index : index + CHAPTER_SUMMARY_INPUT_CHARACTERS]
            for index in range(0, len(evidence), CHAPTER_SUMMARY_INPUT_CHARACTERS)
        ]
        evidence = "\n".join(_summarize_evidence(model, title, part) for part in parts)
    return _summarize_evidence(model, title, evidence)


def _summarize_evidence(model: AiModelConfiguration, title: str, evidence: str) -> str:
    prompt = (
        "为视频章节生成简洁中文摘要，说明本章主题、关键内容与明确结论，使用二至四句。"
        "仅依据提供的本章证据，不补充常识、推测和未出现的结论，不把 OCR 错字当作事实。"
        "不得照抄整段字幕，不写空泛评价。开场、举例和过渡可以只概括内容，不强行写结论或证据不足的套话。"
        "不得把同义解释拆成不同概念，不得反转对象之间的包含、对比或因果关系。"
        f'最多 {CHAPTER_SUMMARY_MAX_CHARACTERS} 字，返回 JSON：{{"summary":"摘要"}}。'
        f"\n章节标题：{title}\n{evidence}"
    )
    messages: list[dict[str, object]] = [{"role": "user", "content": prompt}]
    summary = ""
    for verifying in (False, True):
        if verifying:
            messages.extend(
                [
                    {"role": "assistant", "content": summary},
                    {
                        "role": "user",
                        "content": (
                            "逐项对照原始证据复查草稿的术语、对象关系、数字、步骤和结论。"
                            "删除无证据的推断，纠正把同一个概念误写成两个概念等关系错误；"
                            '只保留本章实际讲述的内容，不补写结论。输出修正后的 JSON：{"summary":"摘要"}。'
                        ),
                    },
                ]
            )
        result = complete_text(
            model,
            messages,
            CHAPTER_TIMEOUT_SECONDS,
            max_tokens=CHAPTER_SUMMARY_MAX_TOKENS,
            disable_thinking=True,
        )
        try:
            summary = ChapterSummary.model_validate_json(_json_content(result)).summary
        except ValidationError as error:
            raise LlmCompletionError("章节摘要格式无效") from error
    return summary


def _json_content(content: str) -> str:
    normalized = content.strip()
    if normalized.startswith("```"):
        normalized = (
            normalized.removeprefix("```json")
            .removeprefix("```")
            .removesuffix("```")
            .strip()
        )
    return normalized
