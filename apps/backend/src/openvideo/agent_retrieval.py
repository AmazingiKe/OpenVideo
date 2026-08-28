"""长视频证据的确定性分层召回、重排与可信度计算。"""

from __future__ import annotations

from dataclasses import dataclass, replace
import hashlib
import json
import math
import re
from typing import Iterable

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
from openvideo.core.identifiers import uuid7
from openvideo.core.media_models import MediaSegment
from openvideo.core.transcription_models import TranscriptSegment


TEMPORAL_BUCKET_COUNT = 8
NEIGHBOR_WINDOW_SECONDS = 45.0
EXACT_QUERY_SCORE = 0.58
TOKEN_OVERLAP_SCORE = 0.36
TITLE_MATCH_BONUS = 0.12
SOURCE_DIVERSITY_BONUS = 0.08
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
    position: int
    start_seconds: float
    end_seconds: float
    title: str | None
    text: str
    relevance_score: float = 0
    match_reasons: tuple[str, ...] = ()
    supporting_sources: tuple[AgentEvidenceSource, ...] = ()
    retrieval_relation: str = "direct"


def retrieve_evidence(
    *,
    asset_id: str,
    query: str | None,
    start_seconds: float | None,
    end_seconds: float | None,
    limit: int,
    duration_seconds: float | None,
    transcript_segments: Iterable[TranscriptSegment],
    analysis_segments: Iterable[MediaSegment],
) -> AgentEvidenceSearchResult:
    normalized_query = _normalize_text(query or "")
    candidates = _build_candidates(transcript_segments, analysis_segments)
    ranged = [
        candidate
        for candidate in candidates
        if _ranges_intersect(
            candidate.start_seconds,
            candidate.end_seconds,
            start_seconds,
            end_seconds,
        )
    ]
    if normalized_query:
        selected = _select_query_evidence(ranged, normalized_query, limit)
    else:
        selected = _select_overview_evidence(
            ranged,
            limit,
            start_seconds,
            end_seconds,
            duration_seconds,
        )
    selected = _merge_duplicate_evidence(selected)
    items = [
        AgentEvidenceItem(
            evidence_id=f"evidence-{uuid7().hex}",
            citation_key=f"E{index}",
            source_type=candidate.source,
            source_version=_source_version(candidate),
            asset_id=asset_id,
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
        ranged,
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


def _build_candidates(
    transcript_segments: Iterable[TranscriptSegment],
    analysis_segments: Iterable[MediaSegment],
) -> list[RetrievalCandidate]:
    candidates = [
        RetrievalCandidate(
            source=AgentEvidenceSource.TRANSCRIPT,
            position=position,
            start_seconds=segment.start_seconds,
            end_seconds=segment.end_seconds,
            title=None,
            text=segment.text.strip(),
        )
        for position, segment in enumerate(transcript_segments)
        if segment.text.strip()
    ]
    field_sources = (
        ("transcript_text", AgentEvidenceSource.TRANSCRIPT),
        ("detailed_summary", AgentEvidenceSource.ANALYSIS),
        ("visual_description", AgentEvidenceSource.VISUAL),
        ("ocr_text", AgentEvidenceSource.OCR),
    )
    for position, segment in enumerate(analysis_segments):
        for field_name, source in field_sources:
            value = getattr(segment, field_name)
            if not value or not value.strip():
                continue
            candidates.append(
                RetrievalCandidate(
                    source=source,
                    position=position,
                    start_seconds=segment.start_seconds,
                    end_seconds=segment.end_seconds,
                    title=(
                        segment.title.strip()
                        if source == AgentEvidenceSource.ANALYSIS
                        and segment.title.strip()
                        else None
                    ),
                    text=value.strip(),
                )
            )
    return candidates


def _select_query_evidence(
    candidates: list[RetrievalCandidate], query: str, limit: int
) -> list[RetrievalCandidate]:
    scored = [_score_candidate(candidate, query) for candidate in candidates]
    matches = [candidate for candidate in scored if candidate.relevance_score > 0]
    matches.sort(
        key=lambda candidate: (
            -candidate.relevance_score,
            candidate.start_seconds,
            candidate.source.value,
        )
    )
    if not matches:
        return []

    source_count = len({candidate.source for candidate in matches})
    seed_limit = min(limit, max(1, math.ceil(limit * 0.65), source_count))
    seeds = _select_diverse_seeds(matches, seed_limit)
    selected = list(seeds)
    selected_keys = {_candidate_key(candidate) for candidate in selected}
    neighbors: list[RetrievalCandidate] = []
    for seed in seeds:
        same_source = [
            candidate
            for candidate in candidates
            if candidate.source == seed.source
            and abs(candidate.position - seed.position) == 1
            and _distance_seconds(candidate, seed) <= NEIGHBOR_WINDOW_SECONDS
        ]
        for neighbor in same_source:
            key = _candidate_key(neighbor)
            if key in selected_keys:
                continue
            neighbors.append(
                replace(
                    neighbor,
                    relevance_score=max(seed.relevance_score * 0.35, 0.08),
                    match_reasons=("邻近上下文",),
                    retrieval_relation="neighbor",
                )
            )
            selected_keys.add(key)
    neighbors.sort(
        key=lambda candidate: (candidate.start_seconds, candidate.source.value)
    )
    selected.extend(neighbors[: max(0, limit - len(selected))])
    selected.sort(
        key=lambda candidate: (
            -candidate.relevance_score,
            candidate.start_seconds,
            candidate.source.value,
        )
    )
    return selected[:limit]


def _select_diverse_seeds(
    candidates: list[RetrievalCandidate], limit: int
) -> list[RetrievalCandidate]:
    selected: list[RetrievalCandidate] = []
    used_sources: set[AgentEvidenceSource] = set()
    used_buckets: set[int] = set()
    extent_start = min(candidate.start_seconds for candidate in candidates)
    extent_end = max(candidate.end_seconds for candidate in candidates)
    for candidate in candidates:
        bucket = _bucket_index(candidate.start_seconds, extent_start, extent_end)
        if candidate.source in used_sources and bucket in used_buckets:
            continue
        diversity_bonus = 0.0
        reasons = list(candidate.match_reasons)
        if candidate.source not in used_sources:
            diversity_bonus = SOURCE_DIVERSITY_BONUS
            reasons.append("来源覆盖")
        selected.append(
            replace(
                candidate,
                relevance_score=min(1.0, candidate.relevance_score + diversity_bonus),
                match_reasons=tuple(reasons),
            )
        )
        used_sources.add(candidate.source)
        used_buckets.add(bucket)
        if len(selected) >= limit:
            return selected
    for candidate in candidates:
        if _candidate_key(candidate) in {_candidate_key(item) for item in selected}:
            continue
        selected.append(candidate)
        if len(selected) >= limit:
            break
    return selected


def _select_overview_evidence(
    candidates: list[RetrievalCandidate],
    limit: int,
    requested_start: float | None,
    requested_end: float | None,
    duration_seconds: float | None,
) -> list[RetrievalCandidate]:
    if not candidates:
        return []
    range_start, range_end = _coverage_range(
        candidates,
        requested_start,
        requested_end,
        duration_seconds,
    )
    bucket_count = min(TEMPORAL_BUCKET_COUNT, limit)
    selected: list[RetrievalCandidate] = []
    selected_keys: set[tuple[object, ...]] = set()
    for bucket in range(bucket_count):
        bucket_start = range_start + (range_end - range_start) * bucket / bucket_count
        bucket_end = (
            range_start + (range_end - range_start) * (bucket + 1) / bucket_count
        )
        available = [
            candidate
            for candidate in candidates
            if _ranges_intersect(
                candidate.start_seconds,
                candidate.end_seconds,
                bucket_start,
                bucket_end,
            )
            and _candidate_key(candidate) not in selected_keys
        ]
        if not available:
            continue
        source_rotation = tuple(AgentEvidenceSource)
        preferred_source = source_rotation[bucket % len(source_rotation)]
        available.sort(
            key=lambda candidate: (
                candidate.source != preferred_source,
                abs(
                    (candidate.start_seconds + candidate.end_seconds) / 2
                    - (bucket_start + bucket_end) / 2
                ),
                candidate.start_seconds,
            )
        )
        chosen = replace(
            available[0],
            relevance_score=0.5,
            match_reasons=("时间覆盖",),
            retrieval_relation="overview",
        )
        selected.append(chosen)
        selected_keys.add(_candidate_key(chosen))
    for candidate in sorted(
        candidates, key=lambda item: (item.start_seconds, item.source.value)
    ):
        if len(selected) >= limit:
            break
        key = _candidate_key(candidate)
        if key in selected_keys:
            continue
        selected.append(
            replace(
                candidate,
                relevance_score=0.35,
                match_reasons=("补充上下文",),
                retrieval_relation="overview",
            )
        )
        selected_keys.add(key)
    selected.sort(
        key=lambda candidate: (candidate.start_seconds, candidate.source.value)
    )
    return selected


def _score_candidate(
    candidate: RetrievalCandidate, normalized_query: str
) -> RetrievalCandidate:
    candidate_text = _normalize_text(
        "\n".join(value for value in (candidate.title, candidate.text) if value)
    )
    query_tokens = _tokens(normalized_query)
    text_tokens = _tokens(candidate_text)
    reasons: list[str] = []
    score = 0.0
    if normalized_query in candidate_text:
        score += EXACT_QUERY_SCORE
        reasons.append("完整短语")
    if query_tokens:
        overlap = len(query_tokens & text_tokens) / len(query_tokens)
        if overlap:
            score += TOKEN_OVERLAP_SCORE * overlap
            reasons.append("关键词匹配")
    if candidate.title and query_tokens & _tokens(_normalize_text(candidate.title)):
        score += TITLE_MATCH_BONUS
        reasons.append("标题匹配")
    return replace(
        candidate,
        relevance_score=min(1.0, score),
        match_reasons=tuple(reasons),
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
                if normalized == _normalize_text(existing.text)
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
            if left.source_type == right.source_type or not _item_ranges_overlap(
                left, right
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


def _bucket_index(value: float, start: float, end: float) -> int:
    if end <= start:
        return 0
    return min(
        TEMPORAL_BUCKET_COUNT - 1,
        int((value - start) / (end - start) * TEMPORAL_BUCKET_COUNT),
    )


def _distance_seconds(left: RetrievalCandidate, right: RetrievalCandidate) -> float:
    if _ranges_intersect(
        left.start_seconds,
        left.end_seconds,
        right.start_seconds,
        right.end_seconds,
    ):
        return 0.0
    return min(
        abs(left.start_seconds - right.end_seconds),
        abs(right.start_seconds - left.end_seconds),
    )


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


def _candidate_key(candidate: RetrievalCandidate) -> tuple[object, ...]:
    return (
        candidate.source,
        round(candidate.start_seconds, 3),
        round(candidate.end_seconds, 3),
        _normalize_text(candidate.text),
    )


def _source_version(candidate: RetrievalCandidate) -> str:
    payload = {
        "source_type": candidate.source.value,
        "start_seconds": candidate.start_seconds,
        "end_seconds": candidate.end_seconds,
        "title": candidate.title,
        "excerpt": candidate.text,
    }
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()


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
