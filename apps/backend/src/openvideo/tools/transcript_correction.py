"""使用上下文校准语音识别文本，不改变字幕时间边界。"""

from __future__ import annotations

import json

from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.analysis_models import Transcript
from openvideo.tools.llm import LlmCompletionError, LlmContextLengthError, complete_text


CORRECTION_MAX_TOKENS = 16_384
CONTEXT_SEGMENT_COUNT = 2
DEFAULT_CORRECTION_TIMEOUT_SECONDS = 120
MAX_CORRECTED_TEXT_CHARACTERS = 10_000
CHUNK_MAX_CHARACTERS = 12_000
CONTEXT_EXTRACTION_MAX_TOKENS = 2_048


class TranscriptCorrectionError(RuntimeError):
    """模型响应无法安全映射回原转录片段时抛出。"""


class TranscriptCorrectionContextLengthError(TranscriptCorrectionError):
    """模型上下文不足时允许 Agent 暂停并请求用户选择降级策略。"""


class LiteLlmTranscriptCorrector:
    """通过可选模型修正文本，同时严格约束可写回的片段集合。"""

    def __init__(self, model: AiModelConfiguration) -> None:
        self.model = model

    def correct(
        self,
        transcript: Transcript,
        segment_indices: list[int],
    ) -> dict[int, str]:
        if not segment_indices:
            return {}
        return self._request_corrections(
            _correction_prompt(transcript, segment_indices),
            segment_indices,
        )

    def correct_chunked(
        self,
        transcript: Transcript,
        segment_indices: list[int],
        global_context: str | None = None,
    ) -> dict[int, str]:
        corrections: dict[int, str] = {}
        for target_indices in _continuous_chunks(transcript, segment_indices):
            context_indices = _context_indices(
                len(transcript.segments), target_indices
            )
            corrections.update(
                self._request_corrections(
                    _correction_prompt(
                        transcript,
                        target_indices,
                        context_indices,
                        global_context,
                    ),
                    target_indices,
                )
            )
        return corrections

    def correct_with_compressed_context(
        self,
        transcript: Transcript,
        segment_indices: list[int],
    ) -> dict[int, str]:
        summaries = [
            self._extract_context(transcript, chunk)
            for chunk in _continuous_chunks(
                transcript,
                list(range(len(transcript.segments))),
            )
        ]
        global_context = self._merge_context(summaries)
        return self.correct_chunked(transcript, segment_indices, global_context)

    def _request_corrections(
        self,
        prompt: str,
        target_indices: list[int],
    ) -> dict[int, str]:
        content = self._complete([{"role": "user", "content": prompt}])
        try:
            return _parse_corrections(content, target_indices)
        except TranscriptCorrectionError as first_error:
            repair_messages = [
                {"role": "assistant", "content": content},
                {
                    "role": "user",
                    "content": (
                        f"上一个响应无法通过校验：{first_error}。"
                        "请只修复响应格式，不重新分析转录，也不要添加解释。"
                        "严格返回 JSON："
                        '{"corrections":[{"index":整数,"text":"修正后的文字"}]}。'
                        "未变化项不要返回；无变化返回空数组。"
                    ),
                },
            ]
            repaired_content = self._complete(repair_messages)
            return _parse_corrections(repaired_content, target_indices)

    def _extract_context(
        self,
        transcript: Transcript,
        segment_indices: list[int],
    ) -> str:
        lines = [
            f"[{index}] {transcript.segments[index].text}"
            for index in segment_indices
        ]
        return self._complete(
            [
                {
                    "role": "user",
                    "content": (
                        "从以下转录片段提取校对所需的术语、人物、组织、主题和语言风格。"
                        "只返回简洁事实列表，不修正文稿。\n\n" + "\n".join(lines)
                    ),
                }
            ],
            max_tokens=CONTEXT_EXTRACTION_MAX_TOKENS,
        )

    def _merge_context(self, summaries: list[str]) -> str:
        if len(summaries) == 1:
            return summaries[0]
        return self._complete(
            [
                {
                    "role": "user",
                    "content": (
                        "合并以下分段上下文，去重后保留统一的术语、人物、组织、主题和语言风格。"
                        "只返回简洁事实列表。\n\n" + "\n\n".join(summaries)
                    ),
                }
            ],
            max_tokens=CONTEXT_EXTRACTION_MAX_TOKENS,
        )

    def _complete(
        self,
        messages: list[dict[str, object]],
        max_tokens: int = CORRECTION_MAX_TOKENS,
    ) -> str:
        try:
            return complete_text(
                self.model,
                messages,
                DEFAULT_CORRECTION_TIMEOUT_SECONDS,
                max_tokens=max_tokens,
                disable_thinking=True,
            )
        except LlmContextLengthError as error:
            raise TranscriptCorrectionContextLengthError(str(error)) from error
        except LlmCompletionError as error:
            raise TranscriptCorrectionError(str(error)) from error


def _context_indices(segment_count: int, target_indices: list[int]) -> list[int]:
    indices: set[int] = set()
    for target_index in target_indices:
        context_start = max(0, target_index - CONTEXT_SEGMENT_COUNT)
        context_end = min(segment_count, target_index + CONTEXT_SEGMENT_COUNT + 1)
        indices.update(range(context_start, context_end))
    return sorted(indices)


def _continuous_chunks(
    transcript: Transcript,
    segment_indices: list[int],
) -> list[list[int]]:
    chunks: list[list[int]] = []
    current_chunk: list[int] = []
    current_characters = 0
    for index in segment_indices:
        text_length = len(transcript.segments[index].text)
        starts_new_range = bool(current_chunk and index != current_chunk[-1] + 1)
        exceeds_limit = bool(
            current_chunk and current_characters + text_length > CHUNK_MAX_CHARACTERS
        )
        if starts_new_range or exceeds_limit:
            chunks.append(current_chunk)
            current_chunk = []
            current_characters = 0
        current_chunk.append(index)
        current_characters += text_length
    if current_chunk:
        chunks.append(current_chunk)
    return chunks


def _correction_prompt(
    transcript: Transcript,
    target_indices: list[int],
    context_indices: list[int] | None = None,
    global_context: str | None = None,
) -> str:
    resolved_context_indices = context_indices or list(range(len(transcript.segments)))
    target_index_set = set(target_indices)
    transcript_lines = [
        _segment_prompt_line(
            index,
            transcript.segments[index].text,
            index in target_index_set,
        )
        for index in resolved_context_indices
    ]
    context_section = f"\n\n全局上下文：\n{global_context}" if global_context else ""
    return (
        "请基于整份上下文校准标记为目标的转录片段。"
        "只修正错字、漏字、同音词、专有名词和必要标点；"
        "不得总结、翻译、扩写、改变原意或口语风格。"
        "上下文片段仅用于理解，不得返回。"
        "只返回发生变化的目标项；未修改片段不要返回；无修改返回空数组。"
        "严格返回 JSON："
        '{"corrections":[{"index":整数,"text":"修正后的文字"}]}。'
        f"{context_section}\n\n" + "\n".join(transcript_lines)
    )


def _segment_prompt_line(index: int, text: str, is_target: bool) -> str:
    role = "目标" if is_target else "上下文"
    return f"[{role} {index}] {text}"


def _parse_corrections(content: str, target_indices: list[int]) -> dict[int, str]:
    normalized_content = content.strip()
    if normalized_content.startswith("```"):
        normalized_content = normalized_content.removeprefix("```json")
        normalized_content = normalized_content.removeprefix("```")
        normalized_content = normalized_content.removesuffix("```").strip()
    try:
        payload = json.loads(normalized_content)
        segments = payload["corrections"]
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        raise TranscriptCorrectionError("模型返回的转录修正格式无效") from error
    if not isinstance(segments, list):
        raise TranscriptCorrectionError("模型返回的转录修正格式无效")

    expected_indices = set(target_indices)
    corrections: dict[int, str] = {}
    for segment in segments:
        if not isinstance(segment, dict):
            raise TranscriptCorrectionError("模型返回的转录修正格式无效")
        index = segment.get("index")
        text = segment.get("text")
        if (
            not isinstance(index, int)
            or index not in expected_indices
            or index in corrections
            or not isinstance(text, str)
            or not text.strip()
            or len(text) > MAX_CORRECTED_TEXT_CHARACTERS
        ):
            raise TranscriptCorrectionError("模型返回了无法应用的转录片段")
        corrections[index] = text.strip()
    return corrections
