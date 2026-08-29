"""Agent 证据的 SQLite 混合索引与资料库自适应语义模型。"""

from __future__ import annotations

from array import array
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
import json
import math
import re
import sqlite3
from typing import Callable, Iterable, Literal, Sequence

from openvideo.core.agent_evidence_models import AgentEvidenceSource
from openvideo.core.identifiers import uuid7
from openvideo.core.media_models import MediaAsset, MediaSegment
from openvideo.core.transcription_models import Transcript


SEMANTIC_MODEL_NAME = "openvideo-library-lsa-v1"
SEMANTIC_MODEL_VERSION = "1"
SEMANTIC_MAX_FEATURES = 2_048
SEMANTIC_MAX_DIMENSIONS = 64
SEMANTIC_BATCH_SIZE = 128
QUERY_CANDIDATE_MULTIPLIER = 6
NEURAL_RERANK_WEIGHT = 0.55
MEMORY_ASSET_BONUS = 0.08
STALE_CONTENT_DIGEST = ""
TOKEN_PATTERN = re.compile(r"[a-z0-9]+|[\u3400-\u9fff]", re.IGNORECASE)


ProgressReporter = Callable[[str, int, int], None]
DocumentEncoder = Callable[[Sequence[str], ProgressReporter], list[list[float]]]
QueryEncoder = Callable[[str, str, str, int], list[float]]
NeuralReranker = Callable[[str, Sequence[str]], list[float]]


@dataclass(frozen=True)
class IndexedEvidenceDocument:
    document_id: str
    asset_id: str
    source_type: AgentEvidenceSource
    source_version: str
    source_position: int
    start_seconds: float
    end_seconds: float
    title: str | None
    text: str
    relevance_score: float
    match_reasons: tuple[str, ...]
    retrieval_relation: Literal["direct", "neighbor", "overview"] = "direct"


@dataclass(frozen=True)
class EvidenceIndexStatus:
    state: Literal["lexical_ready", "semantic_building", "ready", "error"]
    stage: Literal[
        "queued",
        "tokenizing",
        "building_matrix",
        "projecting",
        "downloading_embedding_model",
        "loading_embedding_model",
        "embedding_documents",
        "downloading_reranker_model",
        "loading_reranker_model",
        "committing",
        "ready",
        "failed",
    ]
    processed_documents: int
    total_documents: int
    active_model: str | None
    content_digest: str
    index_task_id: str
    updated_at: datetime
    error_message: str | None = None


@dataclass(frozen=True)
class EvidenceIndexCoverage:
    covered_seconds: float
    duration_seconds: float | None
    document_count: int
    source_types: tuple[AgentEvidenceSource, ...]


class EvidenceIndexChanged(RuntimeError):
    """语义构建期间词法投影已更新，当前代际应立即让位给新任务。"""


def ensure_agent_evidence_schema(connection: sqlite3.Connection) -> None:
    """增量建立可重建索引，避免升级时删除 Agent 会话与运行历史。"""

    with connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS agent_evidence_documents (
                document_id TEXT PRIMARY KEY,
                asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
                source_key TEXT NOT NULL,
                source_type TEXT NOT NULL,
                source_version TEXT NOT NULL,
                source_position INTEGER NOT NULL,
                start_seconds REAL NOT NULL,
                end_seconds REAL NOT NULL,
                title TEXT,
                text TEXT NOT NULL,
                UNIQUE(asset_id, source_key)
            );
            CREATE INDEX IF NOT EXISTS agent_evidence_asset_time_index
                ON agent_evidence_documents(asset_id, start_seconds, end_seconds);
            CREATE INDEX IF NOT EXISTS agent_evidence_asset_source_position_index
                ON agent_evidence_documents(asset_id, source_type, source_position);
            CREATE TABLE IF NOT EXISTS agent_evidence_asset_states (
                asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
                content_digest TEXT NOT NULL
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS agent_evidence_fts USING fts5(
                document_id UNINDEXED,
                asset_id UNINDEXED,
                title,
                text,
                tokenize='trigram'
            );
            CREATE TABLE IF NOT EXISTS agent_verified_memories (
                memory_id TEXT PRIMARY KEY,
                asset_id TEXT REFERENCES assets(asset_id) ON DELETE CASCADE,
                memory_kind TEXT NOT NULL,
                fact_type TEXT NOT NULL,
                fact TEXT NOT NULL,
                source_version TEXT NOT NULL,
                valid INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(asset_id, memory_kind, fact_type)
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS agent_verified_memory_fts USING fts5(
                memory_id UNINDEXED,
                asset_id UNINDEXED,
                fact,
                tokenize='trigram'
            );
            CREATE TABLE IF NOT EXISTS agent_semantic_models (
                model_id TEXT PRIMARY KEY,
                model_name TEXT NOT NULL,
                model_version TEXT NOT NULL DEFAULT '1',
                model_kind TEXT NOT NULL DEFAULT 'lsa',
                content_digest TEXT NOT NULL,
                vocabulary TEXT NOT NULL,
                inverse_document_frequency BLOB NOT NULL,
                projection BLOB NOT NULL,
                feature_count INTEGER NOT NULL,
                dimensions INTEGER NOT NULL,
                active INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent_evidence_embeddings (
                document_id TEXT NOT NULL REFERENCES agent_evidence_documents(document_id)
                    ON DELETE CASCADE,
                model_id TEXT NOT NULL REFERENCES agent_semantic_models(model_id)
                    ON DELETE CASCADE,
                vector BLOB NOT NULL,
                PRIMARY KEY(document_id, model_id)
            );
            CREATE TABLE IF NOT EXISTS agent_evidence_index_status (
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                state TEXT NOT NULL,
                stage TEXT NOT NULL,
                processed_documents INTEGER NOT NULL,
                total_documents INTEGER NOT NULL,
                active_model TEXT,
                content_digest TEXT NOT NULL,
                index_task_id TEXT NOT NULL,
                error_message TEXT,
                updated_at TEXT NOT NULL
            );
            """
        )
        _ensure_semantic_model_columns(connection)
        _ensure_status_columns(connection)
        _ensure_status_row(connection)


def replace_asset_evidence_projection(
    connection: sqlite3.Connection,
    asset: MediaAsset,
    transcript: Transcript | None,
    segments: Iterable[MediaSegment],
    content_digest: str,
) -> None:
    """只替换一个素材的词法投影，旧语义代际保持可用直到新代际切换。"""

    existing = {
        row["source_key"]: (row["document_id"], row["source_version"])
        for row in connection.execute(
            "SELECT document_id, source_key, source_version "
            "FROM agent_evidence_documents WHERE asset_id = ?",
            (asset.asset_id,),
        )
    }
    documents = _source_documents(asset, transcript, segments)
    current_source_keys = {document[0] for document in documents}
    removed_source_keys = set(existing) - current_source_keys
    projection_changed = bool(removed_source_keys)
    for source_key in removed_source_keys:
        document_id = existing[source_key][0]
        connection.execute(
            "DELETE FROM agent_evidence_fts WHERE document_id = ?", (document_id,)
        )
        connection.execute(
            "DELETE FROM agent_evidence_documents WHERE document_id = ?", (document_id,)
        )
    for source_key, source_type, position, start, end, title, text in documents:
        source_version = _source_version(source_type, start, end, title, text)
        previous = existing.get(source_key)
        unchanged = previous is not None and previous[1] == source_version
        projection_changed = projection_changed or not unchanged
        document_id = previous[0] if unchanged else f"evidence-{uuid7().hex}"
        if previous is not None:
            connection.execute(
                "DELETE FROM agent_evidence_fts WHERE document_id = ?", (previous[0],)
            )
        if unchanged:
            connection.execute(
                "UPDATE agent_evidence_documents SET source_position = ? "
                "WHERE document_id = ?",
                (position, document_id),
            )
        else:
            if previous is not None:
                connection.execute(
                    "DELETE FROM agent_evidence_documents WHERE document_id = ?",
                    (previous[0],),
                )
            connection.execute(
                "INSERT INTO agent_evidence_documents "
                "(document_id, asset_id, source_key, source_type, source_version, "
                "source_position, start_seconds, end_seconds, title, text) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    document_id,
                    asset.asset_id,
                    source_key,
                    source_type.value,
                    source_version,
                    position,
                    start,
                    end,
                    title,
                    text,
                ),
            )
        connection.execute(
            "INSERT INTO agent_evidence_fts(document_id, asset_id, title, text) "
            "VALUES (?, ?, ?, ?)",
            (document_id, asset.asset_id, title or "", text),
        )
    _replace_automatic_memories(connection, asset)
    connection.execute(
        "INSERT INTO agent_evidence_asset_states(asset_id, content_digest) "
        "VALUES (?, ?) ON CONFLICT(asset_id) DO UPDATE SET "
        "content_digest = excluded.content_digest",
        (asset.asset_id, content_digest),
    )
    if projection_changed:
        _mark_semantic_index_stale(connection)


def remove_asset_evidence_projection(
    connection: sqlite3.Connection, asset_id: str
) -> None:
    has_documents = connection.execute(
        "SELECT 1 FROM agent_evidence_documents WHERE asset_id = ? LIMIT 1",
        (asset_id,),
    ).fetchone()
    connection.execute("DELETE FROM agent_evidence_fts WHERE asset_id = ?", (asset_id,))
    connection.execute(
        "DELETE FROM agent_verified_memory_fts WHERE asset_id = ?", (asset_id,)
    )
    connection.execute(
        "DELETE FROM agent_evidence_documents WHERE asset_id = ?", (asset_id,)
    )
    connection.execute(
        "DELETE FROM agent_verified_memories WHERE asset_id = ?", (asset_id,)
    )
    connection.execute(
        "DELETE FROM agent_evidence_asset_states WHERE asset_id = ?", (asset_id,)
    )
    if has_documents:
        _mark_semantic_index_stale(connection)


def rebuild_semantic_index(
    connection: sqlite3.Connection,
    *,
    model_name: str = SEMANTIC_MODEL_NAME,
    model_version: str = SEMANTIC_MODEL_VERSION,
    dimensions: int | None = None,
    encode_documents: DocumentEncoder | None = None,
) -> EvidenceIndexStatus:
    """后台构建完整语义代际，新索引提交前继续保留旧代际。"""

    rows = connection.execute(
        "SELECT document_id, title, text FROM agent_evidence_documents "
        "ORDER BY asset_id, start_seconds, source_type"
    ).fetchall()
    digest = _content_digest(connection)
    total = len(rows)
    with connection:
        _write_status(
            connection,
            "semantic_building",
            0,
            total,
            digest,
            stage="tokenizing",
        )
    if not rows:
        with connection:
            if _content_digest(connection) != digest:
                _mark_semantic_index_stale(connection)
                return load_evidence_index_status(connection)
            connection.execute("DELETE FROM agent_semantic_models")
            _write_status(
                connection,
                "ready",
                0,
                0,
                digest,
                stage="ready",
                active_model=None,
                preserve_active_model=False,
            )
        return load_evidence_index_status(connection)
    try:

        def report_progress(stage: str, processed: int, stage_total: int) -> None:
            with connection:
                status_digest = connection.execute(
                    "SELECT content_digest FROM agent_evidence_index_status "
                    "WHERE singleton = 1"
                ).fetchone()["content_digest"]
                if status_digest != digest:
                    raise EvidenceIndexChanged
                _write_status(
                    connection,
                    "semantic_building",
                    processed,
                    stage_total,
                    digest,
                    stage=stage,
                )

        if encode_documents is None:
            tokenized = _tokenize_documents(rows, report_progress)
            vocabulary, inverse_document_frequency = _semantic_vocabulary(tokenized)
            matrix = _semantic_matrix(
                tokenized,
                vocabulary,
                inverse_document_frequency,
                report_progress,
            )
            report_progress("projecting", 0, 0)
            projection, vectors = _latent_vectors(matrix)
            model_kind = "lsa"
            resolved_dimensions = len(projection[0]) if projection else 0
        else:
            if dimensions is None or dimensions <= 0:
                raise ValueError("神经语义索引必须声明向量维度")
            report_progress("loading_embedding_model", 0, 0)
            vectors = encode_documents(
                [f"{row['title'] or ''}\n{row['text']}" for row in rows],
                report_progress,
            )
            _validate_neural_vectors(vectors, total, dimensions)
            vocabulary = {}
            inverse_document_frequency = []
            projection = []
            model_kind = "neural"
            resolved_dimensions = dimensions
        report_progress("committing", 0, 0)
        model_id = f"semantic-index-{uuid7().hex}"
        created_at = datetime.now(UTC).isoformat()
        with connection:
            if _content_digest(connection) != digest:
                _mark_semantic_index_stale(connection)
                return load_evidence_index_status(connection)
            connection.execute(
                "INSERT INTO agent_semantic_models "
                "(model_id, model_name, model_version, model_kind, "
                "content_digest, vocabulary, "
                "inverse_document_frequency, projection, feature_count, dimensions, "
                "active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
                (
                    model_id,
                    model_name,
                    model_version,
                    model_kind,
                    digest,
                    json.dumps(vocabulary, ensure_ascii=False, sort_keys=True),
                    _float_blob(inverse_document_frequency),
                    _matrix_blob(projection),
                    len(vocabulary),
                    resolved_dimensions,
                    created_at,
                ),
            )
            connection.executemany(
                "INSERT INTO agent_evidence_embeddings(document_id, model_id, vector) "
                "VALUES (?, ?, ?)",
                [
                    (row["document_id"], model_id, _float_blob(vector))
                    for row, vector in zip(rows, vectors, strict=True)
                ],
            )
            connection.execute("UPDATE agent_semantic_models SET active = 0")
            connection.execute(
                "UPDATE agent_semantic_models SET active = 1 WHERE model_id = ?",
                (model_id,),
            )
            _write_status(
                connection,
                "ready",
                total,
                total,
                digest,
                stage="ready",
                active_model=model_id,
            )
            connection.execute("DELETE FROM agent_semantic_models WHERE active = 0")
    except EvidenceIndexChanged:
        with connection:
            _mark_semantic_index_stale(connection)
        return load_evidence_index_status(connection)
    except Exception as error:
        with connection:
            _write_status(
                connection,
                "error",
                0,
                total,
                digest,
                stage="failed",
                error_message=str(error) or "语义索引构建失败",
            )
        raise
    return load_evidence_index_status(connection)


def search_indexed_evidence(
    connection: sqlite3.Connection,
    *,
    asset_ids: Iterable[str],
    query: str | None,
    start_seconds: float | None,
    end_seconds: float | None,
    limit: int,
    query_encoder: QueryEncoder | None = None,
    reranker: NeuralReranker | None = None,
) -> list[IndexedEvidenceDocument]:
    scoped_asset_ids = tuple(dict.fromkeys(asset_ids))
    if not scoped_asset_ids:
        return []
    if not query or not query.strip():
        return _overview_documents(
            connection,
            scoped_asset_ids,
            start_seconds,
            end_seconds,
            limit,
        )
    normalized_query = " ".join(query.casefold().split())
    candidate_limit = max(limit, limit * QUERY_CANDIDATE_MULTIPLIER)
    lexical = _lexical_matches(
        connection,
        scoped_asset_ids,
        normalized_query,
        start_seconds,
        end_seconds,
        candidate_limit,
    )
    semantic = _semantic_matches(
        connection,
        scoped_asset_ids,
        normalized_query,
        start_seconds,
        end_seconds,
        candidate_limit,
        query_encoder,
    )
    memory_assets = _memory_asset_matches(
        connection, scoped_asset_ids, normalized_query, candidate_limit
    )
    scores: dict[str, float] = {}
    reasons: dict[str, list[str]] = {}
    rows: dict[str, sqlite3.Row] = {}
    for rank, row in enumerate(lexical):
        document_id = row["document_id"]
        rows[document_id] = row
        scores[document_id] = scores.get(document_id, 0.0) + 0.64 / (1 + rank * 0.18)
        reasons.setdefault(document_id, []).append("FTS5 关键词匹配")
    for row, similarity, model_kind in semantic:
        document_id = row["document_id"]
        rows[document_id] = row
        scores[document_id] = scores.get(document_id, 0.0) + 0.36 * similarity
        reason = (
            "神经语义向量匹配"
            if model_kind == "neural"
            else "资料库语义向量匹配"
        )
        reasons.setdefault(document_id, []).append(reason)
    for row in _memory_context_documents(
        connection,
        memory_assets,
        start_seconds,
        end_seconds,
    ):
        document_id = row["document_id"]
        rows.setdefault(document_id, row)
        scores.setdefault(document_id, 0.0)
        reasons.setdefault(document_id, []).append("已验证项目记忆定位")
    for document_id, row in rows.items():
        if row["asset_id"] in memory_assets:
            scores[document_id] += MEMORY_ASSET_BONUS
            reasons.setdefault(document_id, []).append("项目记忆增强排序")
        haystack = f"{row['title'] or ''} {row['text']}".casefold()
        if normalized_query in haystack:
            scores[document_id] += 0.08
            reasons.setdefault(document_id, []).append("完整短语匹配")
    ranked = sorted(
        rows.values(),
        key=lambda row: (
            -scores[row["document_id"]],
            row["start_seconds"],
            row["source_type"],
        ),
    )
    if reranker is not None and ranked:
        rerank_scores = reranker(
            normalized_query,
            [f"{row['title'] or ''}\n{row['text']}" for row in ranked],
        )
        if len(rerank_scores) != len(ranked):
            raise ValueError("神经重排返回数量与候选数量不一致")
        for row, rerank_score in zip(ranked, rerank_scores, strict=True):
            document_id = row["document_id"]
            hybrid_score = min(1.0, max(0.0, scores[document_id]))
            neural_score = min(1.0, max(0.0, float(rerank_score)))
            scores[document_id] = (
                (1 - NEURAL_RERANK_WEIGHT) * hybrid_score
                + NEURAL_RERANK_WEIGHT * neural_score
            )
            reasons.setdefault(document_id, []).append("神经交叉编码重排")
        ranked.sort(
            key=lambda row: (
                -scores[row["document_id"]],
                row["start_seconds"],
                row["source_type"],
            )
        )
    direct_limit = min(
        limit,
        max(
            1,
            (limit * 2 + 2) // 3,
            len({row["asset_id"] for row in ranked}),
            len({row["source_type"] for row in ranked}),
        ),
    )
    ranked = _select_diverse_rows(ranked, direct_limit)
    documents = [
        _indexed_document(
            row,
            min(1.0, scores[row["document_id"]]),
            tuple(dict.fromkeys(reasons[row["document_id"]])),
        )
        for row in ranked
    ]
    return _append_neighbors(
        connection,
        documents,
        scoped_asset_ids,
        start_seconds,
        end_seconds,
        limit,
    )


def _select_diverse_rows(ranked: list[sqlite3.Row], limit: int) -> list[sqlite3.Row]:
    selected = []
    selected_ids = set()
    used_assets = set()
    used_sources = set()
    for row in ranked:
        if row["asset_id"] in used_assets and row["source_type"] in used_sources:
            continue
        selected.append(row)
        selected_ids.add(row["document_id"])
        used_assets.add(row["asset_id"])
        used_sources.add(row["source_type"])
        if len(selected) == limit:
            return selected
    for row in ranked:
        if row["document_id"] in selected_ids:
            continue
        selected.append(row)
        if len(selected) == limit:
            break
    return selected


def load_evidence_index_status(connection: sqlite3.Connection) -> EvidenceIndexStatus:
    row = connection.execute(
        "SELECT state, stage, processed_documents, total_documents, active_model, "
        "content_digest, index_task_id, error_message, updated_at "
        "FROM agent_evidence_index_status "
        "WHERE singleton = 1"
    ).fetchone()
    assert row is not None
    return EvidenceIndexStatus(
        state=row["state"],
        stage=row["stage"],
        processed_documents=row["processed_documents"],
        total_documents=row["total_documents"],
        active_model=row["active_model"],
        content_digest=row["content_digest"],
        index_task_id=row["index_task_id"],
        updated_at=datetime.fromisoformat(row["updated_at"]),
        error_message=row["error_message"],
    )


def load_evidence_index_coverage(
    connection: sqlite3.Connection,
    asset_id: str | None = None,
) -> EvidenceIndexCoverage:
    parameters: tuple[str, ...] = (asset_id,) if asset_id is not None else ()
    asset_filter = "WHERE asset_id = ?" if asset_id is not None else ""
    rows = connection.execute(
        "SELECT asset_id, source_type, start_seconds, end_seconds "
        f"FROM agent_evidence_documents {asset_filter} "
        "ORDER BY asset_id, start_seconds, end_seconds",
        parameters,
    ).fetchall()
    durations = connection.execute(
        "SELECT duration_seconds FROM assets "
        + ("WHERE asset_id = ?" if asset_id is not None else "ORDER BY asset_id"),
        parameters,
    ).fetchall()
    duration_values = [row["duration_seconds"] for row in durations]
    duration_seconds = (
        sum(float(value) for value in duration_values)
        if duration_values and all(value is not None for value in duration_values)
        else None
    )
    intervals_by_asset: dict[str, list[tuple[float, float]]] = {}
    source_types: set[AgentEvidenceSource] = set()
    for row in rows:
        source_types.add(AgentEvidenceSource(row["source_type"]))
        intervals_by_asset.setdefault(row["asset_id"], []).append(
            (float(row["start_seconds"]), float(row["end_seconds"]))
        )
    covered_seconds = sum(
        _merged_interval_duration(intervals)
        for intervals in intervals_by_asset.values()
    )
    return EvidenceIndexCoverage(
        covered_seconds=covered_seconds,
        duration_seconds=duration_seconds,
        document_count=len(rows),
        source_types=tuple(sorted(source_types, key=lambda source: source.value)),
    )


def ensure_semantic_index_target(
    connection: sqlite3.Connection,
    model_name: str,
    model_version: str,
) -> bool:
    """目标模型变化时只标记待重建，旧代际继续服务到原子切换。"""

    active = connection.execute(
        "SELECT model_name, model_version FROM agent_semantic_models "
        "WHERE active = 1"
    ).fetchone()
    matches = bool(
        active
        and active["model_name"] == model_name
        and active["model_version"] == model_version
    )
    if matches:
        return False
    with connection:
        _mark_semantic_index_stale(connection)
    return True


def save_verified_memory(
    connection: sqlite3.Connection,
    *,
    asset_id: str | None,
    fact_type: str,
    fact: str,
    source_version: str,
    memory_kind: Literal["automatic", "user_confirmed", "execution"] = "user_confirmed",
) -> str:
    """模型推断只有在用户确认后才能进入这里，记忆永远不直接成为证据。"""

    existing = connection.execute(
        "SELECT memory_id FROM agent_verified_memories "
        "WHERE asset_id IS ? AND memory_kind = ? AND fact_type = ?",
        (asset_id, memory_kind, fact_type),
    ).fetchone()
    memory_id = existing["memory_id"] if existing else f"memory-{uuid7().hex}"
    if existing:
        connection.execute(
            "DELETE FROM agent_verified_memory_fts WHERE memory_id = ?",
            (memory_id,),
        )
        connection.execute(
            "UPDATE agent_verified_memories SET fact = ?, source_version = ?, "
            "valid = 1, created_at = ? WHERE memory_id = ?",
            (
                fact.strip(),
                source_version,
                datetime.now(UTC).isoformat(),
                memory_id,
            ),
        )
    else:
        connection.execute(
            "INSERT INTO agent_verified_memories "
            "(memory_id, asset_id, memory_kind, fact_type, fact, source_version, "
            "valid, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
            (
                memory_id,
                asset_id,
                memory_kind,
                fact_type,
                fact.strip(),
                source_version,
                datetime.now(UTC).isoformat(),
            ),
        )
    connection.execute(
        "INSERT INTO agent_verified_memory_fts(memory_id, asset_id, fact) "
        "VALUES (?, ?, ?)",
        (memory_id, asset_id or "", fact.strip()),
    )
    return memory_id


def _source_documents(
    asset: MediaAsset,
    transcript: Transcript | None,
    segments: Iterable[MediaSegment],
) -> list[tuple[str, AgentEvidenceSource, int, float, float, str | None, str]]:
    documents = []
    if transcript is not None:
        documents.extend(
            (
                f"transcript:{position}",
                AgentEvidenceSource.TRANSCRIPT,
                position,
                segment.start_seconds,
                segment.end_seconds,
                None,
                segment.text.strip(),
            )
            for position, segment in enumerate(transcript.segments)
            if segment.text.strip() and segment.end_seconds > segment.start_seconds
        )
    fields = (
        ("transcript_text", AgentEvidenceSource.TRANSCRIPT),
        ("detailed_summary", AgentEvidenceSource.ANALYSIS),
        ("visual_description", AgentEvidenceSource.VISUAL),
        ("ocr_text", AgentEvidenceSource.OCR),
    )
    for position, segment in enumerate(segments):
        for field_name, source_type in fields:
            value = getattr(segment, field_name)
            if not value or not value.strip():
                continue
            documents.append(
                (
                    f"segment:{segment.segment_id}:{field_name}",
                    source_type,
                    position,
                    segment.start_seconds,
                    segment.end_seconds,
                    segment.title.strip()
                    if source_type == AgentEvidenceSource.ANALYSIS
                    and segment.title.strip()
                    else None,
                    value.strip(),
                )
            )
    return documents


def _replace_automatic_memories(
    connection: sqlite3.Connection, asset: MediaAsset
) -> None:
    source_version = hashlib.sha256(
        asset.model_dump_json(exclude_none=True).encode("utf-8")
    ).hexdigest()
    facts = {
        "asset_title": f"素材标题：{asset.title}",
        "asset_duration": (
            f"素材时长：{asset.duration_seconds:.3f} 秒"
            if asset.duration_seconds is not None
            else "素材时长：未知"
        ),
        "asset_origin": "素材来源："
        + "；".join(value for value in (asset.author_name, asset.source_url) if value),
    }
    existing = connection.execute(
        "SELECT memory_id FROM agent_verified_memories "
        "WHERE asset_id = ? AND memory_kind = 'automatic'",
        (asset.asset_id,),
    ).fetchall()
    for row in existing:
        connection.execute(
            "DELETE FROM agent_verified_memory_fts WHERE memory_id = ?",
            (row["memory_id"],),
        )
    connection.execute(
        "DELETE FROM agent_verified_memories "
        "WHERE asset_id = ? AND memory_kind = 'automatic'",
        (asset.asset_id,),
    )
    for fact_type, fact in facts.items():
        if fact.endswith("："):
            continue
        save_verified_memory(
            connection,
            asset_id=asset.asset_id,
            fact_type=fact_type,
            fact=fact,
            source_version=source_version,
            memory_kind="automatic",
        )
    connection.execute(
        "UPDATE agent_verified_memories AS memory SET valid = 0 "
        "WHERE memory.asset_id = ? AND memory.memory_kind != 'automatic' "
        "AND NOT EXISTS (SELECT 1 FROM agent_evidence_documents AS document "
        "WHERE document.asset_id = memory.asset_id "
        "AND document.source_version = memory.source_version)",
        (asset.asset_id,),
    )


def _mark_semantic_index_stale(connection: sqlite3.Connection) -> None:
    total = connection.execute(
        "SELECT COUNT(*) FROM agent_evidence_documents"
    ).fetchone()[0]
    active = connection.execute(
        "SELECT model_id FROM agent_semantic_models WHERE active = 1"
    ).fetchone()
    active_model = active["model_id"] if active else None
    _write_status(
        connection,
        "lexical_ready",
        0,
        total,
        STALE_CONTENT_DIGEST,
        stage="queued",
        active_model=active_model,
    )


def _validate_neural_vectors(
    vectors: list[list[float]],
    expected_count: int,
    expected_dimensions: int,
) -> None:
    if len(vectors) != expected_count:
        raise ValueError("神经嵌入数量与索引文档数量不一致")
    if any(len(vector) != expected_dimensions for vector in vectors):
        raise ValueError("神经嵌入维度与模型声明不一致")
    if any(not all(math.isfinite(value) for value in vector) for vector in vectors):
        raise ValueError("神经嵌入包含非有限数值")


def _lexical_matches(
    connection: sqlite3.Connection,
    asset_ids: tuple[str, ...],
    query: str,
    start_seconds: float | None,
    end_seconds: float | None,
    limit: int,
) -> list[sqlite3.Row]:
    placeholders = ", ".join("?" for _ in asset_ids)
    range_sql, range_parameters = _range_filter(start_seconds, end_seconds)
    if len(query.replace(" ", "")) < 3:
        rows = connection.execute(
            "SELECT * FROM agent_evidence_documents WHERE asset_id IN ("
            f"{placeholders}) {range_sql} AND (title LIKE ? OR text LIKE ?) "
            "ORDER BY start_seconds LIMIT ?",
            (*asset_ids, *range_parameters, f"%{query}%", f"%{query}%", limit),
        ).fetchall()
        return rows
    match_query = '"' + query.replace('"', '""') + '"'
    return connection.execute(
        "SELECT d.* FROM agent_evidence_fts "
        "JOIN agent_evidence_documents d USING(document_id) "
        f"WHERE agent_evidence_fts MATCH ? AND d.asset_id IN ({placeholders}) "
        f"{range_sql} ORDER BY bm25(agent_evidence_fts) LIMIT ?",
        (match_query, *asset_ids, *range_parameters, limit),
    ).fetchall()


def _semantic_matches(
    connection: sqlite3.Connection,
    asset_ids: tuple[str, ...],
    query: str,
    start_seconds: float | None,
    end_seconds: float | None,
    limit: int,
    query_encoder: QueryEncoder | None,
) -> list[tuple[sqlite3.Row, float, str]]:
    model = connection.execute(
        "SELECT * FROM agent_semantic_models WHERE active = 1"
    ).fetchone()
    if model is None:
        return []
    if model["model_kind"] == "neural":
        query_vector = (
            query_encoder(
                query,
                model["model_name"],
                model["model_version"],
                model["dimensions"],
            )
            if query_encoder is not None
            else []
        )
    else:
        query_vector = _semantic_query_vector(model, query)
    if not query_vector:
        return []
    placeholders = ", ".join("?" for _ in asset_ids)
    range_sql, range_parameters = _range_filter(start_seconds, end_seconds)
    rows = connection.execute(
        "SELECT d.*, e.vector FROM agent_evidence_documents d "
        "JOIN agent_evidence_embeddings e ON e.document_id = d.document_id "
        "WHERE e.model_id = ? AND d.asset_id IN ("
        f"{placeholders}) {range_sql}",
        (model["model_id"], *asset_ids, *range_parameters),
    ).fetchall()
    scored = [
        (
            row,
            max(0.0, _dot(query_vector, _blob_floats(row["vector"]))),
            model["model_kind"],
        )
        for row in rows
    ]
    scored.sort(key=lambda item: (-item[1], item[0]["start_seconds"]))
    return [item for item in scored[:limit] if item[1] > 0]


def _memory_asset_matches(
    connection: sqlite3.Connection,
    asset_ids: tuple[str, ...],
    query: str,
    limit: int,
) -> set[str]:
    if len(query.replace(" ", "")) < 3:
        placeholders = ", ".join("?" for _ in asset_ids)
        rows = connection.execute(
            "SELECT asset_id FROM agent_verified_memories WHERE valid = 1 "
            f"AND asset_id IN ({placeholders}) AND fact LIKE ? LIMIT ?",
            (*asset_ids, f"%{query}%", limit),
        ).fetchall()
    else:
        placeholders = ", ".join("?" for _ in asset_ids)
        match_query = '"' + query.replace('"', '""') + '"'
        rows = connection.execute(
            "SELECT m.asset_id FROM agent_verified_memory_fts f "
            "JOIN agent_verified_memories m USING(memory_id) "
            "WHERE agent_verified_memory_fts MATCH ? AND m.valid = 1 "
            f"AND m.asset_id IN ({placeholders}) LIMIT ?",
            (match_query, *asset_ids, limit),
        ).fetchall()
    return {row["asset_id"] for row in rows if row["asset_id"]}


def _memory_context_documents(
    connection: sqlite3.Connection,
    asset_ids: set[str],
    start_seconds: float | None,
    end_seconds: float | None,
) -> list[sqlite3.Row]:
    if not asset_ids:
        return []
    placeholders = ", ".join("?" for _ in asset_ids)
    range_sql, range_parameters = _range_filter(start_seconds, end_seconds)
    return connection.execute(
        "WITH ranked AS (SELECT agent_evidence_documents.*, "
        "ROW_NUMBER() OVER (PARTITION BY asset_id ORDER BY start_seconds, source_type) "
        "AS asset_position FROM agent_evidence_documents WHERE asset_id IN ("
        f"{placeholders}) {range_sql}) SELECT * FROM ranked WHERE asset_position = 1",
        (*sorted(asset_ids), *range_parameters),
    ).fetchall()


def _overview_documents(
    connection: sqlite3.Connection,
    asset_ids: tuple[str, ...],
    start_seconds: float | None,
    end_seconds: float | None,
    limit: int,
) -> list[IndexedEvidenceDocument]:
    placeholders = ", ".join("?" for _ in asset_ids)
    range_sql, range_parameters = _range_filter(start_seconds, end_seconds)
    rows = connection.execute(
        "WITH ranged AS (SELECT * FROM agent_evidence_documents WHERE asset_id IN ("
        f"{placeholders}) {range_sql}), bucketed AS ("
        "SELECT ranged.*, NTILE(?) OVER (ORDER BY asset_id, start_seconds, source_type) "
        "AS evidence_bucket FROM ranged), sampled AS ("
        "SELECT bucketed.*, ROW_NUMBER() OVER (PARTITION BY evidence_bucket "
        "ORDER BY source_type, start_seconds) AS bucket_position FROM bucketed) "
        "SELECT * FROM sampled WHERE bucket_position = 1 "
        "ORDER BY asset_id, start_seconds, source_type LIMIT ?",
        (*asset_ids, *range_parameters, limit, limit),
    ).fetchall()
    return [
        _indexed_document(row, 0.5, ("SQLite 时间覆盖",), "overview") for row in rows
    ]


def _append_neighbors(
    connection: sqlite3.Connection,
    documents: list[IndexedEvidenceDocument],
    asset_ids: tuple[str, ...],
    start_seconds: float | None,
    end_seconds: float | None,
    limit: int,
) -> list[IndexedEvidenceDocument]:
    selected_ids = {document.document_id for document in documents}
    neighbors = []
    for document in documents[: max(1, limit // 2)]:
        rows = connection.execute(
            "SELECT * FROM agent_evidence_documents "
            "WHERE asset_id = ? AND source_type = ? "
            "AND source_position IN (?, ?)",
            (
                document.asset_id,
                document.source_type.value,
                document.source_position - 1,
                document.source_position + 1,
            ),
        ).fetchall()
        for row in rows:
            if (
                row["document_id"] in selected_ids
                or row["asset_id"] not in asset_ids
                or not _ranges_intersect(
                    row["start_seconds"],
                    row["end_seconds"],
                    start_seconds,
                    end_seconds,
                )
            ):
                continue
            selected_ids.add(row["document_id"])
            neighbors.append(
                _indexed_document(
                    row,
                    max(0.08, document.relevance_score * 0.35),
                    ("邻近上下文",),
                    "neighbor",
                )
            )
    return [*documents, *neighbors[: max(0, limit - len(documents))]]


def _indexed_document(
    row: sqlite3.Row,
    score: float,
    reasons: tuple[str, ...],
    relation: Literal["direct", "neighbor", "overview"] = "direct",
) -> IndexedEvidenceDocument:
    return IndexedEvidenceDocument(
        document_id=row["document_id"],
        asset_id=row["asset_id"],
        source_type=AgentEvidenceSource(row["source_type"]),
        source_version=row["source_version"],
        source_position=row["source_position"],
        start_seconds=row["start_seconds"],
        end_seconds=row["end_seconds"],
        title=row["title"],
        text=row["text"],
        relevance_score=round(score, 6),
        match_reasons=reasons,
        retrieval_relation=relation,
    )


def _semantic_vocabulary(
    tokenized: list[list[str]],
) -> tuple[dict[str, int], list[float]]:
    document_frequency = Counter(
        token for document in tokenized for token in set(document)
    )
    ranked = sorted(
        document_frequency,
        key=lambda token: (-document_frequency[token], token),
    )[:SEMANTIC_MAX_FEATURES]
    vocabulary = {token: index for index, token in enumerate(ranked)}
    document_count = max(1, len(tokenized))
    inverse_document_frequency = [
        math.log((1 + document_count) / (1 + document_frequency[token])) + 1
        for token in ranked
    ]
    return vocabulary, inverse_document_frequency


def _tokenize_documents(
    rows: list[sqlite3.Row],
    report_progress: Callable[[str, int, int], None],
) -> list[list[str]]:
    total = len(rows)
    tokenized = []
    for position, row in enumerate(rows, start=1):
        tokenized.append(_semantic_tokens(f"{row['title'] or ''} {row['text']}"))
        if position % SEMANTIC_BATCH_SIZE == 0 or position == total:
            report_progress("tokenizing", position, total)
    return tokenized


def _semantic_matrix(
    tokenized: list[list[str]],
    vocabulary: dict[str, int],
    inverse_document_frequency: list[float],
    report_progress: Callable[[str, int, int], None],
):
    import torch

    matrix = torch.zeros((len(tokenized), len(vocabulary)), dtype=torch.float32)
    for row_index, tokens in enumerate(tokenized):
        counts = Counter(token for token in tokens if token in vocabulary)
        for token, count in counts.items():
            column = vocabulary[token]
            matrix[row_index, column] = (
                math.log1p(count) * inverse_document_frequency[column]
            )
        processed = row_index + 1
        if processed % SEMANTIC_BATCH_SIZE == 0 or processed == len(tokenized):
            report_progress("building_matrix", processed, len(tokenized))
    return matrix


def _latent_vectors(matrix) -> tuple[list[list[float]], list[list[float]]]:
    import torch

    if matrix.shape[1] == 0:
        return [], [[] for _ in range(matrix.shape[0])]
    dimensions = max(
        1,
        min(SEMANTIC_MAX_DIMENSIONS, matrix.shape[0], matrix.shape[1]),
    )
    _, _, right = torch.linalg.svd(matrix, full_matrices=False)
    projection = right[:dimensions].T.contiguous()
    vectors = matrix @ projection
    vectors = torch.nn.functional.normalize(vectors, p=2, dim=1)
    return projection.tolist(), vectors.tolist()


def _semantic_query_vector(model: sqlite3.Row, query: str) -> list[float]:
    vocabulary = json.loads(model["vocabulary"])
    inverse_document_frequency = _blob_floats(model["inverse_document_frequency"])
    projection = _blob_matrix(
        model["projection"], model["feature_count"], model["dimensions"]
    )
    counts = Counter(token for token in _semantic_tokens(query) if token in vocabulary)
    if not counts:
        return []
    features = [0.0] * model["feature_count"]
    for token, count in counts.items():
        index = vocabulary[token]
        features[index] = math.log1p(count) * inverse_document_frequency[index]
    vector = [
        sum(features[row] * projection[row][column] for row in range(len(features)))
        for column in range(model["dimensions"])
    ]
    magnitude = math.sqrt(sum(value * value for value in vector))
    return [value / magnitude for value in vector] if magnitude else []


def _semantic_tokens(value: str) -> list[str]:
    raw = TOKEN_PATTERN.findall(value.casefold())
    tokens = [token for token in raw if len(token) > 1 or not token.isascii()]
    chinese = "".join(
        token for token in raw if len(token) == 1 and "\u3400" <= token <= "\u9fff"
    )
    tokens.extend(
        chinese[index : index + 2] for index in range(max(0, len(chinese) - 1))
    )
    return tokens


def _float_blob(values: Iterable[float]) -> bytes:
    return array("f", values).tobytes()


def _blob_floats(value: bytes) -> list[float]:
    result = array("f")
    result.frombytes(value)
    return result.tolist()


def _matrix_blob(matrix: list[list[float]]) -> bytes:
    return _float_blob(value for row in matrix for value in row)


def _blob_matrix(value: bytes, rows: int, columns: int) -> list[list[float]]:
    flattened = _blob_floats(value)
    return [flattened[index * columns : (index + 1) * columns] for index in range(rows)]


def _dot(left: list[float], right: list[float]) -> float:
    return sum(a * b for a, b in zip(left, right, strict=True))


def _range_filter(
    start_seconds: float | None, end_seconds: float | None
) -> tuple[str, tuple[float, ...]]:
    clauses = []
    parameters = []
    if start_seconds is not None:
        clauses.append("end_seconds >= ?")
        parameters.append(start_seconds)
    if end_seconds is not None:
        clauses.append("start_seconds <= ?")
        parameters.append(end_seconds)
    return (
        ("AND " + " AND ".join(clauses)) if clauses else "",
        tuple(parameters),
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


def _merged_interval_duration(intervals: list[tuple[float, float]]) -> float:
    covered_seconds = 0.0
    current_start: float | None = None
    current_end: float | None = None
    for start_seconds, end_seconds in intervals:
        if end_seconds <= start_seconds:
            continue
        if current_start is None or current_end is None:
            current_start, current_end = start_seconds, end_seconds
            continue
        if start_seconds <= current_end:
            current_end = max(current_end, end_seconds)
            continue
        covered_seconds += current_end - current_start
        current_start, current_end = start_seconds, end_seconds
    if current_start is not None and current_end is not None:
        covered_seconds += current_end - current_start
    return round(covered_seconds, 3)


def _source_version(
    source_type: AgentEvidenceSource,
    start_seconds: float,
    end_seconds: float,
    title: str | None,
    text: str,
) -> str:
    payload = {
        "source_type": source_type.value,
        "start_seconds": start_seconds,
        "end_seconds": end_seconds,
        "title": title,
        "excerpt": text,
    }
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()


def _content_digest(connection: sqlite3.Connection) -> str:
    digest = hashlib.sha256()
    for row in connection.execute(
        "SELECT document_id, source_version FROM agent_evidence_documents "
        "ORDER BY document_id"
    ):
        digest.update(row["document_id"].encode("utf-8"))
        digest.update(row["source_version"].encode("ascii"))
    return digest.hexdigest()


def _ensure_status_row(connection: sqlite3.Connection) -> None:
    connection.execute(
        "INSERT OR IGNORE INTO agent_evidence_index_status "
        "(singleton, state, stage, processed_documents, total_documents, "
        "active_model, content_digest, index_task_id, error_message, updated_at) "
        "VALUES (1, 'lexical_ready', 'queued', 0, 0, NULL, ?, ?, NULL, ?)",
        (
            hashlib.sha256(b"").hexdigest(),
            f"index-task-{uuid7().hex}",
            datetime.now(UTC).isoformat(),
        ),
    )


def _ensure_semantic_model_columns(connection: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in connection.execute("PRAGMA table_info(agent_semantic_models)")
    }
    if "model_version" not in columns:
        connection.execute(
            "ALTER TABLE agent_semantic_models "
            "ADD COLUMN model_version TEXT NOT NULL DEFAULT '1'"
        )
    if "model_kind" not in columns:
        connection.execute(
            "ALTER TABLE agent_semantic_models "
            "ADD COLUMN model_kind TEXT NOT NULL DEFAULT 'lsa'"
        )


def _ensure_status_columns(connection: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in connection.execute(
            "PRAGMA table_info(agent_evidence_index_status)"
        ).fetchall()
    }
    if "stage" not in columns:
        connection.execute(
            "ALTER TABLE agent_evidence_index_status "
            "ADD COLUMN stage TEXT NOT NULL DEFAULT 'queued'"
        )
        connection.execute(
            "UPDATE agent_evidence_index_status SET stage = CASE state "
            "WHEN 'semantic_building' THEN 'tokenizing' "
            "WHEN 'ready' THEN 'ready' WHEN 'error' THEN 'failed' "
            "ELSE 'queued' END"
        )
    if "index_task_id" not in columns:
        connection.execute(
            "ALTER TABLE agent_evidence_index_status ADD COLUMN index_task_id TEXT"
        )
    connection.execute(
        "UPDATE agent_evidence_index_status SET index_task_id = ? "
        "WHERE index_task_id IS NULL OR index_task_id = ''",
        (f"index-task-{uuid7().hex}",),
    )


def _write_status(
    connection: sqlite3.Connection,
    state: str,
    processed: int,
    total: int,
    digest: str,
    *,
    stage: str,
    active_model: str | None = None,
    preserve_active_model: bool = True,
    error_message: str | None = None,
) -> None:
    if active_model is None and preserve_active_model:
        row = connection.execute(
            "SELECT active_model FROM agent_evidence_index_status WHERE singleton = 1"
        ).fetchone()
        active_model = row["active_model"] if row else None
    task_row = connection.execute(
        "SELECT index_task_id FROM agent_evidence_index_status WHERE singleton = 1"
    ).fetchone()
    index_task_id = (
        task_row["index_task_id"]
        if task_row and task_row["index_task_id"]
        else f"index-task-{uuid7().hex}"
    )
    connection.execute(
        "INSERT INTO agent_evidence_index_status "
        "(singleton, state, stage, processed_documents, total_documents, "
        "active_model, content_digest, index_task_id, error_message, updated_at) "
        "VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(singleton) DO UPDATE SET state = excluded.state, "
        "stage = excluded.stage, "
        "processed_documents = excluded.processed_documents, "
        "total_documents = excluded.total_documents, active_model = excluded.active_model, "
        "content_digest = excluded.content_digest, "
        "index_task_id = excluded.index_task_id, "
        "error_message = excluded.error_message, updated_at = excluded.updated_at",
        (
            state,
            stage,
            processed,
            total,
            active_model,
            digest,
            index_task_id,
            error_message,
            datetime.now(UTC).isoformat(),
        ),
    )
