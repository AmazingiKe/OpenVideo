"""对自动配图结果执行可重复的离线质量评测。"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from openvideo.core.summary_models import SummaryIllustrationConfidence


DUPLICATE_TIME_DISTANCE_SECONDS = 1


class ExpectedVisualWindow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str = Field(min_length=1, max_length=300)
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(gt=0)


class EvaluatedIllustration(BaseModel):
    model_config = ConfigDict(extra="forbid")

    selected_time: float | None = Field(default=None, ge=0)
    inserted: bool
    confidence: SummaryIllustrationConfidence | None = None
    clarity_score: float = Field(default=0, ge=0, le=1)
    source_excerpt: str | None = None
    latency_ms: int = Field(default=0, ge=0)
    estimated_vision_cost: float = Field(default=0, ge=0)


class IllustrationEvaluationCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    case_id: str = Field(min_length=1, max_length=300)
    expected_windows: list[ExpectedVisualWindow] = Field(default_factory=list)
    illustrations: list[EvaluatedIllustration] = Field(default_factory=list)


class IllustrationEvaluationMetrics(BaseModel):
    model_config = ConfigDict(extra="forbid")

    case_count: int = Field(ge=0)
    inserted_count: int = Field(ge=0)
    relevance: float = Field(ge=0, le=1)
    clarity: float = Field(ge=0, le=1)
    coverage: float = Field(ge=0, le=1)
    duplicate_rate: float = Field(ge=0, le=1)
    bad_insertion_rate: float = Field(ge=0, le=1)
    average_latency_ms: float = Field(ge=0)
    estimated_vision_cost: float = Field(ge=0)


def evaluate_illustrations(
    cases: list[IllustrationEvaluationCase],
) -> IllustrationEvaluationMetrics:
    inserted = [
        illustration
        for case in cases
        for illustration in case.illustrations
        if illustration.inserted and illustration.selected_time is not None
    ]
    relevant = sum(
        _matches_any_window(illustration.selected_time, case.expected_windows)
        for case in cases
        for illustration in case.illustrations
        if illustration.inserted and illustration.selected_time is not None
    )
    expected_window_count = sum(len(case.expected_windows) for case in cases)
    covered_windows = sum(
        any(
            illustration.inserted
            and illustration.selected_time is not None
            and window.start_seconds <= illustration.selected_time <= window.end_seconds
            for illustration in case.illustrations
        )
        for case in cases
        for window in case.expected_windows
    )
    duplicate_count = sum(_case_duplicate_count(case) for case in cases)
    duplicate_pairs = sum(
        _pair_count(
            len(
                [
                    illustration
                    for illustration in case.illustrations
                    if illustration.inserted and illustration.selected_time is not None
                ]
            )
        )
        for case in cases
    )
    bad_insertions = sum(
        illustration.confidence != SummaryIllustrationConfidence.HIGH
        or not _matches_any_window(illustration.selected_time, case.expected_windows)
        for case in cases
        for illustration in case.illustrations
        if illustration.inserted and illustration.selected_time is not None
    )
    inserted_count = len(inserted)
    return IllustrationEvaluationMetrics(
        case_count=len(cases),
        inserted_count=inserted_count,
        relevance=_ratio(relevant, inserted_count),
        clarity=(
            sum(illustration.clarity_score for illustration in inserted)
            / inserted_count
            if inserted_count
            else 0
        ),
        coverage=_ratio(covered_windows, expected_window_count),
        duplicate_rate=_ratio(duplicate_count, duplicate_pairs),
        bad_insertion_rate=_ratio(bad_insertions, inserted_count),
        average_latency_ms=(
            sum(illustration.latency_ms for illustration in inserted) / inserted_count
            if inserted_count
            else 0
        ),
        estimated_vision_cost=sum(
            illustration.estimated_vision_cost
            for case in cases
            for illustration in case.illustrations
        ),
    )


def _matches_any_window(
    selected_time: float,
    windows: list[ExpectedVisualWindow],
) -> bool:
    return any(
        window.start_seconds <= selected_time <= window.end_seconds
        for window in windows
    )


def _case_duplicate_count(case: IllustrationEvaluationCase) -> int:
    inserted = [
        illustration
        for illustration in case.illustrations
        if illustration.inserted and illustration.selected_time is not None
    ]
    duplicates = 0
    for index, first in enumerate(inserted):
        for second in inserted[index + 1 :]:
            same_time = (
                abs(first.selected_time - second.selected_time)
                <= DUPLICATE_TIME_DISTANCE_SECONDS
            )
            same_source = (
                first.source_excerpt is not None
                and first.source_excerpt == second.source_excerpt
            )
            duplicates += same_time or same_source
    return duplicates


def _pair_count(item_count: int) -> int:
    return item_count * (item_count - 1) // 2


def _ratio(numerator: int, denominator: int) -> float:
    return numerator / denominator if denominator else 0
