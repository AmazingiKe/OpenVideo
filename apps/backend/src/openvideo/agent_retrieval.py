"""长视频证据的确定性分层召回、重排与可信度计算。"""

from __future__ import annotations

from dataclasses import dataclass, replace
import re
from typing import Iterable

from openvideo.core.agent_evidence_index import IndexedEvidenceDocument
from openvideo.core.agent_evidence_models import (
    AgentEvidenceBundle,
    AgentEvidenceCoverage,
    AgentEvidenceConfidence,
    AgentEvidenceConflict,
    AgentEvidenceItem,
    AgentEvidenceSearchResult,
    AgentEvidenceSource,
    AgentAnswerStatus,
)


TEMPORAL_BUCKET_COUNT = 8
HIGH_RELEVANCE_THRESHOLD = 0.72
MEDIUM_RELEVANCE_THRESHOLD = 0.3
HIGH_OVERVIEW_COVERAGE = 0.6
MEDIUM_OVERVIEW_COVERAGE = 0.3
CONFLICT_TOKEN_OVERLAP = 0.4
NEGATION_TERMS = frozenset({"不", "未", "没有", "无", "不是", "no", "not", "never"})
TOKEN_PATTERN = re.compile(r"[a-z0-9]+|[\u3400-\u9fff]", re.IGNORECASE)
NUMBER_PATTERN = re.compile(r"(?<![a-z])\d+(?:\.\d+)?", re.IGNORECASE)


@dataclass(frozen=True)
class RetrievalCandidate:
    source: AgentEvidenceSource
    start_seconds: float
    end_seconds: float
    title: str | None
    text: str
    asset_id: str
    evidence_id: str
    source_version: str
    relevance_score: float = 0
    match_reasons: tuple[str, ...] = ()
    supporting_sources: tuple[AgentEvidenceSource, ...] = ()
    retrieval_relation: str = "direct"


def retrieve_indexed_evidence(
    *,
    documents: Iterable[IndexedEvidenceDocument],
    query: str | None,
    start_seconds: float | None,
    end_seconds: float | None,
    limit: int,
    duration_seconds: float | None,
) -> AgentEvidenceSearchResult:
    """把持久化混合召回转换为统一证据契约，不再二次覆盖索引评分。"""

    candidates = [
        RetrievalCandidate(
            source=document.source_type,
            start_seconds=document.start_seconds,
            end_seconds=document.end_seconds,
            title=document.title,
            text=document.text,
            relevance_score=document.relevance_score,
            match_reasons=document.match_reasons,
            retrieval_relation=document.retrieval_relation,
            asset_id=document.asset_id,
            evidence_id=document.document_id,
            source_version=document.source_version,
        )
        for document in documents
    ]
    selected = sorted(
        candidates,
        key=lambda candidate: (
            -candidate.relevance_score,
            candidate.asset_id,
            candidate.start_seconds,
            candidate.source.value,
        ),
    )
    return _build_search_result(
        candidates=candidates,
        selected=selected,
        query=query,
        normalized_query=_normalize_text(query or ""),
        start_seconds=start_seconds,
        end_seconds=end_seconds,
        duration_seconds=duration_seconds,
        limit=limit,
    )


def _build_search_result(
    *,
    candidates: list[RetrievalCandidate],
    selected: list[RetrievalCandidate],
    query: str | None,
    normalized_query: str,
    start_seconds: float | None,
    end_seconds: float | None,
    duration_seconds: float | None,
    limit: int,
) -> AgentEvidenceSearchResult:
    selected = _merge_duplicate_evidence(selected)
    items = [
        AgentEvidenceItem(
            evidence_id=candidate.evidence_id,
            citation_key=f"E{index}",
            source_type=candidate.source,
            source_version=candidate.source_version,
            asset_id=candidate.asset_id,
            start_seconds=candidate.start_seconds,
            end_seconds=candidate.end_seconds,
            title=candidate.title,
            excerpt=candidate.text,
            relation="supports",
            retrieval_relation=candidate.retrieval_relation,
            relevance_score=round(candidate.relevance_score, 4),
            match_reasons=list(candidate.match_reasons),
            supporting_source_types=list(candidate.supporting_sources),
        )
        for index, candidate in enumerate(selected[:limit], start=1)
    ]
    range_start, range_end = _coverage_range(
        candidates,
        start_seconds,
        end_seconds,
        duration_seconds,
    )
    temporal_coverage = _temporal_coverage(items, range_start, range_end)
    conflicts = _find_conflicts(items)
    conflicting_evidence_ids = {
        evidence_id for conflict in conflicts for evidence_id in conflict.evidence_ids
    }
    if conflicting_evidence_ids:
        items = [
            item.model_copy(update={"relation": "conflicts"})
            if item.evidence_id in conflicting_evidence_ids
            else item
            for item in items
        ]
    confidence, confidence_reasons = _confidence(
        items,
        normalized_query,
        temporal_coverage,
        conflicts,
    )
    source_coverage = sorted(
        {
            source
            for item in items
            for source in (item.source_type, *item.supporting_source_types)
        },
        key=lambda source: source.value,
    )
    answer_status = _answer_status(confidence, items, conflicts)
    evidence_bundle = AgentEvidenceBundle(
        query=query.strip() if query and query.strip() else None,
        start_seconds=start_seconds,
        end_seconds=end_seconds,
        items=items,
        conflicts=conflicts,
        coverage=AgentEvidenceCoverage(
            temporal=round(temporal_coverage, 4),
            source_types=source_coverage,
        ),
    )
    return AgentEvidenceSearchResult(
        confidence=confidence,
        confidence_reasons=confidence_reasons,
        answer_status=answer_status,
        evidence_bundle=evidence_bundle,
        answer_instruction=_answer_instruction(confidence, items, conflicts),
    )


def _merge_duplicate_evidence(
    candidates: list[RetrievalCandidate],
) -> list[RetrievalCandidate]:
    merged: list[RetrievalCandidate] = []
    for candidate in candidates:
        normalized = _normalize_text(candidate.text)
        duplicate_index = next(
            (
                index
                for index, existing in enumerate(merged)
                if candidate.asset_id == existing.asset_id
                and normalized == _normalize_text(existing.text)
                and _overlap_ratio(candidate, existing) >= 0.8
            ),
            None,
        )
        if duplicate_index is None:
            merged.append(candidate)
            continue
        existing = merged[duplicate_index]
        sources = tuple(
            dict.fromkeys(
                source
                for source in (
                    *existing.supporting_sources,
                    candidate.source,
                    *candidate.supporting_sources,
                )
                if source != existing.source
            )
        )
        merged[duplicate_index] = replace(
            existing,
            relevance_score=max(existing.relevance_score, candidate.relevance_score),
            match_reasons=tuple(
                dict.fromkeys(
                    (*existing.match_reasons, *candidate.match_reasons, "多源一致")
                )
            ),
            supporting_sources=sources,
            retrieval_relation="corroborated",
        )
    return merged


def _find_conflicts(
    evidence: list[AgentEvidenceItem],
) -> list[AgentEvidenceConflict]:
    conflicts: list[AgentEvidenceConflict] = []
    for index, left in enumerate(evidence):
        for right in evidence[index + 1 :]:
            if (
                left.asset_id != right.asset_id
                or left.source_type == right.source_type
                or not _item_ranges_overlap(left, right)
            ):
                continue
            left_tokens = _tokens_without_numbers(left.excerpt)
            right_tokens = _tokens_without_numbers(right.excerpt)
            union = left_tokens | right_tokens
            overlap = len(left_tokens & right_tokens) / len(union) if union else 0
            if overlap < CONFLICT_TOKEN_OVERLAP:
                continue
            left_numbers = set(NUMBER_PATTERN.findall(left.excerpt.casefold()))
            right_numbers = set(NUMBER_PATTERN.findall(right.excerpt.casefold()))
            numeric_conflict = (
                bool(left_numbers)
                and bool(right_numbers)
                and left_numbers != right_numbers
            )
            negation_conflict = _has_negation(left.excerpt) != _has_negation(
                right.excerpt
            )
            if not numeric_conflict and not negation_conflict:
                continue
            conflicts.append(
                AgentEvidenceConflict(
                    evidence_ids=[left.evidence_id, right.evidence_id],
                    reason=(
                        "重叠时间范围的不同来源包含冲突数值"
                        if numeric_conflict
                        else "重叠时间范围的不同来源肯定与否定表述不一致"
                    ),
                )
            )
    return conflicts


def _confidence(
    evidence: list[AgentEvidenceItem],
    normalized_query: str,
    temporal_coverage: float,
    conflicts: list[AgentEvidenceConflict],
) -> tuple[AgentEvidenceConfidence, list[str]]:
    if conflicts:
        return AgentEvidenceConfidence.LOW, ["不同来源的证据存在未消除冲突"]
    if not evidence:
        return AgentEvidenceConfidence.LOW, ["没有找到支持当前问题的证据"]
    source_count = len(
        {
            source
            for item in evidence
            for source in (item.source_type, *item.supporting_source_types)
        }
    )
    if not normalized_query:
        if temporal_coverage >= HIGH_OVERVIEW_COVERAGE and len(evidence) >= 3:
            return AgentEvidenceConfidence.HIGH, ["证据覆盖了视频主要时间范围"]
        if temporal_coverage >= MEDIUM_OVERVIEW_COVERAGE:
            return AgentEvidenceConfidence.MEDIUM, ["证据只覆盖了部分时间范围"]
        return AgentEvidenceConfidence.LOW, ["全片证据的时间覆盖不足"]
    best_score = max(item.relevance_score for item in evidence)
    if best_score >= HIGH_RELEVANCE_THRESHOLD and source_count >= 2:
        return AgentEvidenceConfidence.HIGH, ["问题与多来源证据高度匹配"]
    if best_score >= MEDIUM_RELEVANCE_THRESHOLD:
        reason = (
            "问题有直接匹配证据，但缺少第二来源交叉验证"
            if source_count == 1
            else "问题与证据中度匹配"
        )
        return AgentEvidenceConfidence.MEDIUM, [reason]
    return AgentEvidenceConfidence.LOW, ["问题与现有证据的匹配度不足"]


def _answer_instruction(
    confidence: AgentEvidenceConfidence,
    evidence: list[AgentEvidenceItem],
    conflicts: list[AgentEvidenceConflict],
) -> str:
    citations = "、".join(f"[{item.citation_key}]" for item in evidence)
    if conflicts:
        return f"只能给出暂定结论；并列说明冲突证据 {citations}，不得自行选边。"
    if confidence == AgentEvidenceConfidence.LOW:
        return f"明确标注确定性低并说明缺少什么；只能引用现有证据 {citations}。"
    return f"结论中的事实必须引用对应证据 {citations}，并标注确定性{_confidence_label(confidence)}。"


def _answer_status(
    confidence: AgentEvidenceConfidence,
    evidence: list[AgentEvidenceItem],
    conflicts: list[AgentEvidenceConflict],
) -> AgentAnswerStatus:
    if not evidence:
        return AgentAnswerStatus.INSUFFICIENT
    if confidence == AgentEvidenceConfidence.LOW or conflicts:
        return AgentAnswerStatus.PROVISIONAL
    return AgentAnswerStatus.FINAL


def _confidence_label(confidence: AgentEvidenceConfidence) -> str:
    return {
        AgentEvidenceConfidence.HIGH: "高",
        AgentEvidenceConfidence.MEDIUM: "中",
        AgentEvidenceConfidence.LOW: "低",
    }[confidence]


def _coverage_range(
    candidates: list[RetrievalCandidate],
    requested_start: float | None,
    requested_end: float | None,
    duration_seconds: float | None,
) -> tuple[float, float]:
    start = requested_start if requested_start is not None else 0.0
    candidate_end = max(
        (candidate.end_seconds for candidate in candidates), default=0.0
    )
    end = (
        requested_end
        if requested_end is not None
        else max(duration_seconds or 0.0, candidate_end)
    )
    return start, max(start + 0.001, end)


def _temporal_coverage(
    evidence: list[AgentEvidenceItem], range_start: float, range_end: float
) -> float:
    if not evidence or range_end <= range_start:
        return 0.0
    covered = 0
    for bucket in range(TEMPORAL_BUCKET_COUNT):
        bucket_start = (
            range_start + (range_end - range_start) * bucket / TEMPORAL_BUCKET_COUNT
        )
        bucket_end = (
            range_start
            + (range_end - range_start) * (bucket + 1) / TEMPORAL_BUCKET_COUNT
        )
        if any(
            _ranges_intersect(
                item.start_seconds,
                item.end_seconds,
                bucket_start,
                bucket_end,
            )
            for item in evidence
        ):
            covered += 1
    return covered / TEMPORAL_BUCKET_COUNT


def _normalize_text(value: str) -> str:
    return " ".join(value.casefold().split())


def _tokens(value: str) -> set[str]:
    raw_tokens = TOKEN_PATTERN.findall(value)
    tokens = set(raw_tokens)
    chinese = "".join(
        token
        for token in raw_tokens
        if len(token) == 1 and "\u3400" <= token <= "\u9fff"
    )
    tokens.update(
        chinese[index : index + 2] for index in range(max(0, len(chinese) - 1))
    )
    return {token for token in tokens if token}


def _tokens_without_numbers(value: str) -> set[str]:
    return {
        token
        for token in _tokens(_normalize_text(value))
        if not NUMBER_PATTERN.fullmatch(token)
    }


def _has_negation(value: str) -> bool:
    normalized = _normalize_text(value)
    return any(term in normalized for term in NEGATION_TERMS)


def _ranges_intersect(
    start: float,
    end: float,
    range_start: float | None,
    range_end: float | None,
) -> bool:
    return not (
        (range_start is not None and end < range_start)
        or (range_end is not None and start > range_end)
    )


def _overlap_ratio(left: RetrievalCandidate, right: RetrievalCandidate) -> float:
    intersection = max(
        0.0,
        min(left.end_seconds, right.end_seconds)
        - max(left.start_seconds, right.start_seconds),
    )
    union = max(left.end_seconds, right.end_seconds) - min(
        left.start_seconds, right.start_seconds
    )
    return intersection / union if union else 1.0


def _item_ranges_overlap(left: AgentEvidenceItem, right: AgentEvidenceItem) -> bool:
    return _ranges_intersect(
        left.start_seconds,
        left.end_seconds,
        right.start_seconds,
        right.end_seconds,
    )
