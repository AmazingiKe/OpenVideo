"""把转写文本切分为重点片段，供视觉分析定位关键画面。

当前用启发式打分：把转写按时间桶聚合，用文本长度与关键词命中估算内容
重要程度，再选出 top-N 个重点片段。后续可在此之上叠加 LLM 精排。
"""

from __future__ import annotations

from dataclasses import dataclass

from openvideo.core.analysis_models import Transcript, TranscriptSegment


# 教程/知识类视频里常见的重要性信号词；命中越多越值得分析画面。
IMPORTANCE_KEYWORDS = {
    "重点": 3.0,
    "重要": 3.0,
    "关键": 3.0,
    "核心": 3.0,
    "结论": 3.0,
    "公式": 3.0,
    "注意": 2.0,
    "记住": 2.5,
    "总结": 2.0,
    "所以": 1.5,
    "必须": 2.0,
}


@dataclass(frozen=True)
class KeyMoment:
    """一个值得做画面分析的时间片段。"""

    start_seconds: float
    end_seconds: float
    transcript_text: str
    score: float


def select_key_moments(
    transcript: Transcript,
    bucket_seconds: float = 30.0,
    max_moments: int = 8,
) -> list[KeyMoment]:
    """按时间桶聚合转写并启发式打分，返回分数最高的重点片段。"""
    if not transcript.segments:
        return []
    buckets: dict[int, _Bucket] = {}
    for segment in transcript.segments:
        bucket_index = int(segment.start_seconds // bucket_seconds)
        bucket = buckets.setdefault(bucket_index, _Bucket())
        bucket.segments.append(segment)
        bucket.score += _segment_score(segment)

    ranked = sorted(buckets.items(), key=lambda item: item[1].score, reverse=True)
    moments: list[KeyMoment] = []
    for bucket_index, bucket in ranked[:max_moments]:
        start_seconds = bucket_index * bucket_seconds
        moments.append(
            KeyMoment(
                start_seconds=start_seconds,
                end_seconds=start_seconds + bucket_seconds,
                transcript_text=_merge_text(bucket.segments),
                score=bucket.score,
            )
        )
    return sorted(moments, key=lambda moment: moment.start_seconds)


class _Bucket:
    def __init__(self) -> None:
        self.segments: list[TranscriptSegment] = []
        self.score: float = 0.0


def _segment_score(segment: TranscriptSegment) -> float:
    length_score = min(len(segment.text) / 20.0, 2.0)
    keyword_score = sum(
        weight for keyword, weight in IMPORTANCE_KEYWORDS.items() if keyword in segment.text
    )
    return length_score + keyword_score


def _merge_text(segments: list[TranscriptSegment]) -> str:
    return " ".join(segment.text for segment in segments if segment.text.strip())
