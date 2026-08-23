"""使用上下文校准语音识别文本，不改变字幕时间边界。"""

from __future__ import annotations

import json

import httpx

from openvideo.core.analysis_models import Transcript


CORRECTION_BATCH_SIZE = 24
CONTEXT_SEGMENT_COUNT = 2
DEFAULT_CORRECTION_TIMEOUT_SECONDS = 120
MAX_CORRECTED_TEXT_CHARACTERS = 10_000


class TranscriptCorrectionError(RuntimeError):
    """模型响应无法安全映射回原转录片段时抛出。"""


class OpenAiCompatibleTranscriptCorrector:
    """调用 OpenAI 兼容接口，并把模型输出限制为目标片段的文字修正。"""

    def __init__(self, base_url: str, api_key: str, model: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model

    def correct(
        self,
        transcript: Transcript,
        segment_indices: list[int],
    ) -> dict[int, str]:
        corrected_segments: dict[int, str] = {}
        for start in range(0, len(segment_indices), CORRECTION_BATCH_SIZE):
            batch_indices = segment_indices[start : start + CORRECTION_BATCH_SIZE]
            corrected_segments.update(
                self._correct_batch(transcript, batch_indices)
            )
        return corrected_segments

    def _correct_batch(
        self,
        transcript: Transcript,
        target_indices: list[int],
    ) -> dict[int, str]:
        context_indices = _context_indices(len(transcript.segments), target_indices)
        transcript_lines = [
            _segment_prompt_line(
                index,
                transcript.segments[index].text,
                index in target_indices,
            )
            for index in context_indices
        ]
        prompt = (
            "请根据相邻语句校准目标转录片段中的明显语音识别错误。"
            "只修正错字、漏字、同音词、专有名词和必要标点；"
            "不得总结、翻译、扩写或改变原意和口语风格。"
            "上下文片段仅用于理解，不得返回。"
            "严格返回 JSON：{\"segments\":[{\"index\":整数,\"text\":\"修正文字\"}]}，"
            "每个目标索引必须且只能出现一次。\n\n"
            + "\n".join(transcript_lines)
        )
        payload = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
        }
        try:
            response = httpx.post(
                f"{self.base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=DEFAULT_CORRECTION_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except httpx.HTTPError as error:
            raise TranscriptCorrectionError(f"转录修正请求失败：{error}") from error

        try:
            content = (
                response.json()
                .get("choices", [{}])[0]
                .get("message", {})
                .get("content")
            )
        except (AttributeError, IndexError, ValueError) as error:
            raise TranscriptCorrectionError("模型返回的转录修正格式无效") from error
        if not isinstance(content, str) or not content.strip():
            raise TranscriptCorrectionError("模型未返回有效的转录修正结果")
        return _parse_corrections(content, target_indices)


def _context_indices(segment_count: int, target_indices: list[int]) -> list[int]:
    indices: set[int] = set()
    for target_index in target_indices:
        context_start = max(0, target_index - CONTEXT_SEGMENT_COUNT)
        context_end = min(segment_count, target_index + CONTEXT_SEGMENT_COUNT + 1)
        indices.update(range(context_start, context_end))
    return sorted(indices)


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
        segments = payload["segments"]
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
    if set(corrections) != expected_indices:
        raise TranscriptCorrectionError("模型没有返回全部目标转录片段")
    return corrections
