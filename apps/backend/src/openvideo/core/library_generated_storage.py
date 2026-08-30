from __future__ import annotations

from array import array
import json
import sqlite3
from datetime import UTC, datetime
from typing import Literal

from openvideo.core.agent_checkpoint_store import (
    load_agent_checkpoint,
    load_agent_checkpoints,
    save_agent_checkpoint,
)
from openvideo.core.agent_evidence_index import (
    DocumentEncoder,
    EvidenceIndexCoverage,
    EvidenceIndexStatus,
    IndexedEvidenceDocument,
    NeuralReranker,
    QueryEncoder,
    ensure_semantic_index_target,
    load_evidence_index_coverage,
    load_evidence_index_status,
    rebuild_semantic_index,
    save_verified_memory,
    search_indexed_evidence,
)
from openvideo.core.agent_runtime_models import (
    AgentArtifact,
    AgentArtifactStatus,
    AgentChangeVersion,
    AgentEvent,
    AgentEventType,
    AgentRun,
    AgentRunCheckpoint,
    AgentRunStage,
    AgentSession,
)
from openvideo.core.agent_governance_models import (
    AgentPermissionGrant,
    AgentPermissionGrantScope,
)
from openvideo.core.identifiers import uuid7
from openvideo.core.library_index import (
    DATABASE_FILE_NAME,
    open_index_connection,
    synchronize_asset,
)
from openvideo.core.library_files import atomic_write_model
from openvideo.core.summary_files import load_version_manifest, write_version_manifest
from openvideo.core.summary_models import (
    SummaryDocument,
    SummaryIllustrationJob,
    SummaryMediaArtifact,
    SummaryVersion,
)
from openvideo.core.visual_index_models import VisualIndexStatus

AGENT_CHANGES_DIRECTORY_NAME = "agent-changes"
AGENT_CHANGE_VERSION_PATTERN = "agent-version-*.json"


class LibraryGeneratedStorageMixin:
    """集中保存总结与 Agent 运行产物，避免生命周期逻辑耦合数据库细节。"""

    def search_agent_evidence(
        self,
        *,
        asset_ids: list[str],
        query: str | None,
        start_seconds: float | None,
        end_seconds: float | None,
        limit: int,
        query_encoder: QueryEncoder | None = None,
        reranker: NeuralReranker | None = None,
    ) -> list[IndexedEvidenceDocument]:
        for asset_id in asset_ids:
            self._validate_asset_id(asset_id)
        with self._lock:
            return search_indexed_evidence(
                self._db(),
                asset_ids=asset_ids,
                query=query,
                start_seconds=start_seconds,
                end_seconds=end_seconds,
                limit=limit,
                query_encoder=query_encoder,
                reranker=reranker,
            )

    def save_visual_index_status(self, status: VisualIndexStatus) -> None:
        values = status.model_dump(mode="json", exclude={"model_loaded"})
        columns = tuple(values)
        updates = ", ".join(f"{column}=excluded.{column}" for column in columns)
        with self._lock, self._db():
            self._db().execute(
                "INSERT INTO visual_index_status "
                f"(singleton, {', '.join(columns)}) VALUES "
                f"(1, {', '.join('?' for _ in columns)}) "
                f"ON CONFLICT(singleton) DO UPDATE SET {updates}",
                tuple(values[column] for column in columns),
            )

    def load_visual_index_status(self) -> VisualIndexStatus | None:
        row = (
            self._db()
            .execute(
                "SELECT state, progress_percent, message, model_name, model_revision, "
                "indexed_frames, total_frames, error_message, updated_at "
                "FROM visual_index_status WHERE singleton = 1"
            )
            .fetchone()
        )
        return VisualIndexStatus.model_validate(dict(row)) if row else None

    def replace_visual_frame_embeddings(
        self,
        *,
        asset_id: str,
        model_name: str,
        model_revision: str,
        dimensions: int,
        frames: list[tuple[str, float, str, list[float]]],
    ) -> None:
        self._validate_asset_id(asset_id)
        now = datetime.now(UTC).isoformat()
        with self._lock, self._db():
            self._db().execute(
                "DELETE FROM visual_frame_embeddings WHERE asset_id = ?",
                (asset_id,),
            )
            self._db().executemany(
                "INSERT INTO visual_frame_embeddings "
                "(asset_id, relative_path, seconds, model_name, model_revision, "
                "dimensions, vector, content_digest, indexed_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    (
                        asset_id,
                        relative_path,
                        seconds,
                        model_name,
                        model_revision,
                        dimensions,
                        array("f", vector).tobytes(),
                        content_digest,
                        now,
                    )
                    for relative_path, seconds, content_digest, vector in frames
                ],
            )

    def load_visual_frame_vectors(
        self,
        *,
        asset_id: str,
        model_name: str,
        model_revision: str,
    ) -> list[tuple[str, float, list[float]]]:
        self._validate_asset_id(asset_id)
        rows = (
            self._db()
            .execute(
                "SELECT relative_path, seconds, dimensions, vector "
                "FROM visual_frame_embeddings WHERE asset_id = ? "
                "AND model_name = ? AND model_revision = ? ORDER BY seconds",
                (asset_id, model_name, model_revision),
            )
            .fetchall()
        )
        vectors: list[tuple[str, float, list[float]]] = []
        for row in rows:
            vector = array("f")
            vector.frombytes(row["vector"])
            if len(vector) != row["dimensions"]:
                continue
            vectors.append((row["relative_path"], row["seconds"], vector.tolist()))
        return vectors

    def rebuild_agent_semantic_index(
        self,
        *,
        model_name: str,
        model_version: str,
        dimensions: int,
        encode_documents: DocumentEncoder,
    ) -> EvidenceIndexStatus:
        connection = open_index_connection(self.library_path / DATABASE_FILE_NAME)
        try:
            return rebuild_semantic_index(
                connection,
                model_name=model_name,
                model_version=model_version,
                dimensions=dimensions,
                encode_documents=encode_documents,
            )
        finally:
            connection.close()

    def ensure_agent_semantic_index_target(
        self,
        model_name: str,
        model_version: str,
    ) -> bool:
        with self._lock:
            return ensure_semantic_index_target(
                self._db(),
                model_name,
                model_version,
            )

    def agent_evidence_index_status(self) -> EvidenceIndexStatus:
        with self._lock:
            return load_evidence_index_status(self._db())

    def agent_evidence_index_coverage(
        self,
        asset_id: str | None = None,
    ) -> EvidenceIndexCoverage:
        if asset_id is not None:
            self._validate_asset_id(asset_id)
        with self._lock:
            return load_evidence_index_coverage(self._db(), asset_id)

    def save_agent_verified_memory(
        self,
        *,
        asset_id: str | None,
        fact_type: str,
        fact: str,
        source_version: str,
        memory_kind: Literal["user_confirmed", "execution"] = "user_confirmed",
    ) -> str:
        if asset_id is not None:
            self._validate_asset_id(asset_id)
        if memory_kind not in {"user_confirmed", "execution"}:
            raise ValueError("项目记忆类型无效")
        with self._lock, self._db():
            return save_verified_memory(
                self._db(),
                asset_id=asset_id,
                fact_type=fact_type,
                fact=fact,
                source_version=source_version,
                memory_kind=memory_kind,
            )

    def create_summary_documents(
        self, documents: list[SummaryDocument]
    ) -> list[SummaryDocument]:
        if not documents:
            return []
        asset_ids = {document.asset_id for document in documents}
        if len(asset_ids) != 1:
            raise ValueError("总结文档必须属于同一个素材")
        for document in documents:
            self._validate_identifier(document.document_id, "document")
        asset_id = next(iter(asset_ids))
        synchronize_asset(self._db(), self.assets_path, asset_id)
        loaded = {
            item.document_id: item for item in self.load_summary_documents(asset_id)
        }
        if any(document.document_id not in loaded for document in documents):
            raise ValueError("总结 manifest 未包含全部新文档")
        return [loaded[document.document_id] for document in documents]

    def load_summary_document(self, document_id: str) -> SummaryDocument | None:
        self._validate_identifier(document_id, "document")
        row = (
            self._db()
            .execute(
                "SELECT * FROM summary_documents WHERE document_id = ?", (document_id,)
            )
            .fetchone()
        )
        return self._summary_document_from_row(row) if row else None

    def load_summary_documents(
        self,
        asset_id: str,
        version_id: str | None = None,
    ) -> list[SummaryDocument]:
        self._validate_asset_id(asset_id)
        where = "asset_id = ?"
        parameters = [asset_id]
        if version_id is not None:
            self._validate_identifier(version_id, "summary-version")
            where += " AND version_id = ?"
            parameters.append(version_id)
        rows = (
            self._db()
            .execute(
                f"SELECT * FROM summary_documents WHERE {where} "
                "ORDER BY parent_document_id IS NOT NULL, position, created_at",
                tuple(parameters),
            )
            .fetchall()
        )
        return [self._summary_document_from_row(row) for row in rows]

    def load_summary_versions(self, asset_id: str) -> list[SummaryVersion]:
        self._validate_asset_id(asset_id)
        rows = (
            self._db()
            .execute(
                "SELECT * FROM summary_versions WHERE asset_id = ? ORDER BY created_at DESC",
                (asset_id,),
            )
            .fetchall()
        )
        versions: list[SummaryVersion] = []
        for row in rows:
            values = dict(row)
            values["context_summary"] = json.loads(values["context_summary"])
            versions.append(SummaryVersion.model_validate(values))
        return versions

    def update_summary_document(
        self,
        document_id: str,
        expected_revision: int,
        *,
        title: str | None = None,
        relative_path: str | None = None,
        content_digest: str | None = None,
        position: int | None = None,
    ) -> SummaryDocument | None:
        document = self.load_summary_document(document_id)
        if document is None:
            return None
        synchronize_asset(self._db(), self.assets_path, document.asset_id)
        updated = self.load_summary_document(document_id)
        if updated is None or updated.revision != expected_revision + 1:
            return None
        return updated

    def delete_summary_document(self, document_id: str) -> bool:
        document = self.load_summary_document(document_id)
        if document is None:
            return False
        synchronize_asset(self._db(), self.assets_path, document.asset_id)
        return self.load_summary_document(document_id) is None

    def save_agent_session(self, session: AgentSession) -> None:
        self._validate_identifier(session.session_id, "session")
        values = session.model_dump(mode="json")
        values["context"] = json.dumps(values["context"], ensure_ascii=False)
        self._upsert_runtime_model("agent_sessions", values)

    def load_agent_session(self, session_id: str) -> AgentSession | None:
        self._validate_identifier(session_id, "session")
        row = (
            self._db()
            .execute("SELECT * FROM agent_sessions WHERE session_id = ?", (session_id,))
            .fetchone()
        )
        if row is None:
            return None
        values = dict(row)
        values["context"] = json.loads(values["context"])
        return AgentSession.model_validate(values)

    def load_agent_sessions(
        self, *, agent_id: str | None = None, asset_id: str | None = None
    ) -> list[AgentSession]:
        clauses: list[str] = []
        parameters: list[str] = []
        if agent_id is not None:
            clauses.append("agent_id = ?")
            parameters.append(agent_id)
        if asset_id is not None:
            self._validate_asset_id(asset_id)
            clauses.append("asset_id = ?")
            parameters.append(asset_id)
        where_clause = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = (
            self._db()
            .execute(
                f"SELECT * FROM agent_sessions{where_clause} ORDER BY updated_at DESC",
                tuple(parameters),
            )
            .fetchall()
        )
        sessions: list[AgentSession] = []
        for row in rows:
            values = dict(row)
            values["context"] = json.loads(values["context"])
            sessions.append(AgentSession.model_validate(values))
        return sessions

    def delete_agent_session(self, session_id: str) -> bool:
        self._validate_identifier(session_id, "session")
        with self._lock, self._db():
            cursor = self._db().execute(
                "DELETE FROM agent_sessions WHERE session_id = ?", (session_id,)
            )
        return cursor.rowcount > 0

    def save_agent_session_permission_grant(self, grant: AgentPermissionGrant) -> None:
        if grant.scope != AgentPermissionGrantScope.SESSION:
            raise ValueError("资料库只能保存本次对话授权")
        if grant.session_id is None:
            raise ValueError("本次对话授权必须绑定会话")
        self._validate_identifier(grant.session_id, "session")
        values = grant.model_dump(mode="json")
        columns = tuple(values)
        with self._lock, self._db():
            self._db().execute(
                f"INSERT OR IGNORE INTO agent_permission_grants "
                f"({', '.join(columns)}) VALUES "
                f"({', '.join('?' for _ in columns)})",
                tuple(values[column] for column in columns),
            )

    def load_agent_session_permission_grants(
        self, session_id: str
    ) -> list[AgentPermissionGrant]:
        self._validate_identifier(session_id, "session")
        rows = (
            self._db()
            .execute(
                "SELECT * FROM agent_permission_grants WHERE session_id = ?",
                (session_id,),
            )
            .fetchall()
        )
        return [AgentPermissionGrant.model_validate(dict(row)) for row in rows]

    def save_agent_run(self, run: AgentRun) -> None:
        self._validate_identifier(run.run_id, "run")
        values = run.model_dump(mode="json")
        values["metrics"] = json.dumps(values["metrics"], ensure_ascii=False)
        self._upsert_runtime_model("agent_runs", values)

    def save_agent_run_checkpoint(self, checkpoint: AgentRunCheckpoint) -> None:
        self._validate_identifier(checkpoint.run_id, "run")
        self._validate_identifier(checkpoint.session_id, "session")
        with self._lock:
            save_agent_checkpoint(self._checkpoint_db(), checkpoint)

    def load_agent_run_checkpoint(
        self,
        run_id: str,
    ) -> AgentRunCheckpoint | None:
        self._validate_identifier(run_id, "run")
        with self._lock:
            return load_agent_checkpoint(self._checkpoint_db(), run_id)

    def load_agent_run_checkpoints(self) -> list[AgentRunCheckpoint]:
        with self._lock:
            return load_agent_checkpoints(self._checkpoint_db())

    def update_agent_run_checkpoint(
        self,
        run_id: str,
        stage: AgentRunStage,
        *,
        resume_allowed: bool,
    ) -> AgentRunCheckpoint | None:
        checkpoint = self.load_agent_run_checkpoint(run_id)
        if checkpoint is None:
            return None
        updated = checkpoint.model_copy(
            update={
                "stage": stage,
                "resume_allowed": resume_allowed,
                "updated_at": datetime.now(UTC),
            }
        )
        self.save_agent_run_checkpoint(updated)
        return updated

    def interrupt_agent_run_checkpoints(self) -> None:
        for checkpoint in self.load_agent_run_checkpoints():
            if checkpoint.stage in {AgentRunStage.PENDING, AgentRunStage.RUNNING}:
                self.update_agent_run_checkpoint(
                    checkpoint.run_id,
                    AgentRunStage.INTERRUPTED,
                    resume_allowed=True,
                )

    def load_agent_run(self, run_id: str) -> AgentRun | None:
        self._validate_identifier(run_id, "run")
        row = (
            self._db()
            .execute("SELECT * FROM agent_runs WHERE run_id = ?", (run_id,))
            .fetchone()
        )
        return self._agent_run_from_row(row) if row else None

    def load_agent_runs(self, session_id: str | None = None) -> list[AgentRun]:
        if session_id is None:
            rows = (
                self._db()
                .execute("SELECT * FROM agent_runs ORDER BY created_at")
                .fetchall()
            )
        else:
            self._validate_identifier(session_id, "session")
            rows = (
                self._db()
                .execute(
                    "SELECT * FROM agent_runs WHERE session_id = ? ORDER BY created_at",
                    (session_id,),
                )
                .fetchall()
            )
        return [self._agent_run_from_row(row) for row in rows]

    def load_agent_run_by_request_key(self, request_key: str) -> AgentRun | None:
        row = (
            self._db()
            .execute("SELECT * FROM agent_runs WHERE request_key = ?", (request_key,))
            .fetchone()
        )
        return self._agent_run_from_row(row) if row else None

    def append_agent_event(
        self,
        session_id: str,
        run_id: str | None,
        event_type: AgentEventType,
        payload: dict[str, object],
    ) -> AgentEvent:
        self._validate_identifier(session_id, "session")
        if run_id is not None:
            self._validate_identifier(run_id, "run")
        with self._lock, self._db():
            sequence = (
                self._db()
                .execute(
                    "SELECT COALESCE(MAX(sequence), 0) + 1 FROM agent_events "
                    "WHERE session_id = ?",
                    (session_id,),
                )
                .fetchone()[0]
            )
            event = AgentEvent(
                event_id=f"event-{uuid7().hex}",
                session_id=session_id,
                sequence=sequence,
                run_id=run_id,
                event_type=event_type,
                payload=payload,
            )
            values = event.model_dump(mode="json")
            values["payload"] = json.dumps(values["payload"], ensure_ascii=False)
            columns = tuple(values)
            self._db().execute(
                f"INSERT INTO agent_events ({', '.join(columns)}) "
                f"VALUES ({', '.join('?' for _ in columns)})",
                tuple(values[column] for column in columns),
            )
            self._db().execute(
                "UPDATE agent_sessions SET updated_at = ? WHERE session_id = ?",
                (event.created_at.isoformat(), session_id),
            )
            if run_id is not None:
                self._db().execute(
                    "UPDATE agent_runs SET latest_event_sequence = ?, updated_at = ? "
                    "WHERE run_id = ?",
                    (event.sequence, event.created_at.isoformat(), run_id),
                )
        return event

    def load_agent_events(
        self, session_id: str, *, after_sequence: int = 0
    ) -> list[AgentEvent]:
        self._validate_identifier(session_id, "session")
        rows = (
            self._db()
            .execute(
                "SELECT * FROM agent_events WHERE session_id = ? AND sequence > ? "
                "ORDER BY sequence",
                (session_id, after_sequence),
            )
            .fetchall()
        )
        events: list[AgentEvent] = []
        for row in rows:
            values = dict(row)
            values["payload"] = json.loads(values["payload"])
            events.append(AgentEvent.model_validate(values))
        return events

    def interrupt_agent_runs(self) -> None:
        now = datetime.now(UTC)
        active_stages = (AgentRunStage.PENDING.value, AgentRunStage.RUNNING.value)
        rows = (
            self._db()
            .execute("SELECT * FROM agent_runs WHERE stage IN (?, ?)", active_stages)
            .fetchall()
        )
        for row in rows:
            run = self._agent_run_from_row(row).model_copy(
                update={
                    "stage": AgentRunStage.INTERRUPTED,
                    "error_message": "应用重启中断了 Agent 运行",
                    "updated_at": now,
                }
            )
            self.save_agent_run(run)
            self.append_agent_event(
                run.session_id,
                run.run_id,
                AgentEventType.RUN_FAILED,
                {"stage": AgentRunStage.INTERRUPTED.value},
            )

    @staticmethod
    def _agent_run_from_row(row: sqlite3.Row) -> AgentRun:
        values = dict(row)
        values["metrics"] = json.loads(values["metrics"])
        return AgentRun.model_validate(values)

    def save_agent_artifact(self, artifact: AgentArtifact) -> None:
        self._validate_identifier(artifact.artifact_id, "artifact")
        values = artifact.model_dump(mode="json")
        values["payload"] = json.dumps(values["payload"], ensure_ascii=False)
        self._upsert_runtime_model("agent_artifacts", values)

    def claim_agent_artifact(self, artifact_id: str) -> AgentArtifact | None:
        """用数据库比较并交换取得唯一执行权，防止并发审批重复产生副作用。"""

        return self._transition_agent_artifact(
            artifact_id,
            AgentArtifactStatus.PENDING,
            AgentArtifactStatus.APPLYING,
        )

    def finish_agent_artifact(
        self,
        artifact_id: str,
        status: AgentArtifactStatus,
        error_message: str | None = None,
        application_result: dict[str, object] | None = None,
    ) -> AgentArtifact | None:
        """只有已取得执行权的审批才能落入唯一终态。"""

        if status not in {
            AgentArtifactStatus.APPROVED,
            AgentArtifactStatus.STALE,
            AgentArtifactStatus.FAILED,
        }:
            raise ValueError("审批执行只能结束为已批准、已过期或失败")
        if application_result is None:
            return self._transition_agent_artifact(
                artifact_id,
                AgentArtifactStatus.APPLYING,
                status,
                error_message,
            )
        self._validate_identifier(artifact_id, "artifact")
        updated_at = datetime.now(UTC)
        with self._lock, self._db():
            row = (
                self._db()
                .execute(
                    "SELECT payload FROM agent_artifacts "
                    "WHERE artifact_id = ? AND status = ?",
                    (artifact_id, AgentArtifactStatus.APPLYING.value),
                )
                .fetchone()
            )
            if row is None:
                return None
            payload = json.loads(row["payload"])
            payload["application_result"] = application_result
            cursor = self._db().execute(
                "UPDATE agent_artifacts SET status = ?, payload = ?, "
                "error_message = ?, updated_at = ? "
                "WHERE artifact_id = ? AND status = ?",
                (
                    status.value,
                    json.dumps(payload, ensure_ascii=False),
                    error_message,
                    updated_at.isoformat(),
                    artifact_id,
                    AgentArtifactStatus.APPLYING.value,
                ),
            )
            if cursor.rowcount != 1:
                return None
            updated_row = (
                self._db()
                .execute(
                    "SELECT * FROM agent_artifacts WHERE artifact_id = ?",
                    (artifact_id,),
                )
                .fetchone()
            )
        return self._agent_artifact_from_row(updated_row) if updated_row else None

    def reject_agent_artifact(self, artifact_id: str) -> AgentArtifact | None:
        """拒绝只允许从待审批状态发生，不能覆盖正在应用的操作。"""

        return self._transition_agent_artifact(
            artifact_id,
            AgentArtifactStatus.PENDING,
            AgentArtifactStatus.REJECTED,
        )

    def claim_agent_artifact_undo(self, artifact_id: str) -> AgentArtifact | None:
        """比较并交换取得唯一撤销权。"""

        return self._transition_agent_artifact(
            artifact_id,
            AgentArtifactStatus.APPROVED,
            AgentArtifactStatus.UNDOING,
        )

    def finish_agent_artifact_undo(self, artifact_id: str) -> AgentArtifact | None:
        return self._transition_agent_artifact(
            artifact_id,
            AgentArtifactStatus.UNDOING,
            AgentArtifactStatus.UNDONE,
        )

    def cancel_agent_artifact_undo(
        self,
        artifact_id: str,
        error_message: str,
    ) -> AgentArtifact | None:
        return self._transition_agent_artifact(
            artifact_id,
            AgentArtifactStatus.UNDOING,
            AgentArtifactStatus.APPROVED,
            error_message,
        )

    def save_agent_change_version(
        self,
        version: AgentChangeVersion,
    ) -> None:
        self._validate_identifier(version.change_version_id, "agent-version")
        self._validate_identifier(version.artifact_id, "artifact")
        self._validate_asset_id(version.asset_id)
        directory = (
            self.artifacts_directory(version.asset_id) / AGENT_CHANGES_DIRECTORY_NAME
        )
        directory.mkdir(parents=True, exist_ok=True)
        if directory.is_symlink():
            raise ValueError("Agent 变更历史目录不能是符号链接")
        atomic_write_model(directory / f"{version.change_version_id}.json", version)

    def load_agent_change_versions(self, asset_id: str) -> list[AgentChangeVersion]:
        self._validate_asset_id(asset_id)
        directory = self.artifacts_directory(asset_id) / AGENT_CHANGES_DIRECTORY_NAME
        if not directory.is_dir() or directory.is_symlink():
            return []
        versions: list[AgentChangeVersion] = []
        for path in directory.glob(AGENT_CHANGE_VERSION_PATTERN):
            if path.is_symlink():
                continue
            try:
                version = AgentChangeVersion.model_validate_json(
                    path.read_text(encoding="utf-8")
                )
            except (OSError, ValueError):
                continue
            if version.asset_id == asset_id:
                versions.append(version)
        return sorted(versions, key=lambda item: item.committed_at)

    def mark_agent_change_version_undone(
        self,
        asset_id: str,
        change_version_id: str,
    ) -> AgentChangeVersion:
        version = next(
            (
                item
                for item in self.load_agent_change_versions(asset_id)
                if item.change_version_id == change_version_id
            ),
            None,
        )
        if version is None:
            raise ValueError("Agent 变更版本不存在")
        updated = version.model_copy(update={"undone_at": datetime.now(UTC)})
        self.save_agent_change_version(updated)
        return updated

    def delete_agent_change_version(
        self,
        asset_id: str,
        change_version_id: str,
    ) -> None:
        """仅用于审批事务回滚尚未对用户可见的版本记录。"""

        self._validate_asset_id(asset_id)
        self._validate_identifier(change_version_id, "agent-version")
        directory = self.artifacts_directory(asset_id) / AGENT_CHANGES_DIRECTORY_NAME
        path = directory / f"{change_version_id}.json"
        if path.parent.resolve() != directory.resolve() or path.is_symlink():
            raise ValueError("Agent 变更版本路径无效")
        path.unlink(missing_ok=True)

    def _transition_agent_artifact(
        self,
        artifact_id: str,
        expected_status: AgentArtifactStatus,
        target_status: AgentArtifactStatus,
        error_message: str | None = None,
    ) -> AgentArtifact | None:
        self._validate_identifier(artifact_id, "artifact")
        updated_at = datetime.now(UTC)
        with self._lock, self._db():
            cursor = self._db().execute(
                "UPDATE agent_artifacts SET status = ?, error_message = ?, updated_at = ? "
                "WHERE artifact_id = ? AND status = ?",
                (
                    target_status.value,
                    error_message,
                    updated_at.isoformat(),
                    artifact_id,
                    expected_status.value,
                ),
            )
            if cursor.rowcount != 1:
                return None
            row = (
                self._db()
                .execute(
                    "SELECT * FROM agent_artifacts WHERE artifact_id = ?",
                    (artifact_id,),
                )
                .fetchone()
            )
        return self._agent_artifact_from_row(row) if row else None

    def load_agent_artifact(self, artifact_id: str) -> AgentArtifact | None:
        self._validate_identifier(artifact_id, "artifact")
        row = (
            self._db()
            .execute(
                "SELECT * FROM agent_artifacts WHERE artifact_id = ?", (artifact_id,)
            )
            .fetchone()
        )
        return self._agent_artifact_from_row(row) if row else None

    def load_agent_artifacts(
        self, *, run_id: str | None = None, session_id: str | None = None
    ) -> list[AgentArtifact]:
        if run_id is not None and session_id is not None:
            raise ValueError("运行与会话筛选不能同时提供")
        if run_id is not None:
            self._validate_identifier(run_id, "run")
            rows = (
                self._db()
                .execute(
                    "SELECT * FROM agent_artifacts "
                    "WHERE run_id = ? ORDER BY created_at",
                    (run_id,),
                )
                .fetchall()
            )
        elif session_id is not None:
            self._validate_identifier(session_id, "session")
            rows = (
                self._db()
                .execute(
                    "SELECT * FROM agent_artifacts "
                    "WHERE session_id = ? ORDER BY created_at",
                    (session_id,),
                )
                .fetchall()
            )
        else:
            rows = (
                self._db()
                .execute("SELECT * FROM agent_artifacts ORDER BY created_at")
                .fetchall()
            )
        return [self._agent_artifact_from_row(row) for row in rows]

    @staticmethod
    def _agent_artifact_from_row(row: sqlite3.Row) -> AgentArtifact:
        values = dict(row)
        values["payload"] = json.loads(values["payload"])
        return AgentArtifact.model_validate(values)

    def save_summary_media(self, media: SummaryMediaArtifact) -> None:
        self._validate_identifier(media.media_id, "media")
        asset_directory = self.asset_directory(media.asset_id)
        manifest = load_version_manifest(asset_directory, media.version_id)
        if any(item.media_id == media.media_id for item in manifest.media):
            raise sqlite3.IntegrityError("总结媒体标识已存在")
        write_version_manifest(
            asset_directory,
            manifest.model_copy(update={"media": [*manifest.media, media]}),
        )
        synchronize_asset(self._db(), self.assets_path, media.asset_id)

    def save_summary_illustration_job(self, job: SummaryIllustrationJob) -> None:
        self._validate_identifier(job.job_id, "summary-illustration-job")
        values = job.model_dump(mode="json", exclude={"slots", "metrics"})
        values["slots"] = json.dumps(
            [slot.model_dump(mode="json") for slot in job.slots],
            ensure_ascii=False,
        )
        values["metrics"] = job.metrics.model_dump_json()
        self._upsert_runtime_model("summary_illustration_jobs", values)

    def load_summary_illustration_job(
        self, job_id: str
    ) -> SummaryIllustrationJob | None:
        self._validate_identifier(job_id, "summary-illustration-job")
        row = (
            self._db()
            .execute(
                "SELECT * FROM summary_illustration_jobs WHERE job_id = ?", (job_id,)
            )
            .fetchone()
        )
        return self._summary_illustration_job_from_row(row) if row else None

    def load_summary_illustration_jobs(
        self,
        *,
        asset_id: str | None = None,
        version_id: str | None = None,
    ) -> list[SummaryIllustrationJob]:
        clauses: list[str] = []
        parameters: list[str] = []
        if asset_id is not None:
            self._validate_asset_id(asset_id)
            clauses.append("asset_id = ?")
            parameters.append(asset_id)
        if version_id is not None:
            self._validate_identifier(version_id, "summary-version")
            clauses.append("version_id = ?")
            parameters.append(version_id)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = (
            self._db()
            .execute(
                "SELECT * FROM summary_illustration_jobs"
                f"{where} ORDER BY created_at DESC",
                tuple(parameters),
            )
            .fetchall()
        )
        return [self._summary_illustration_job_from_row(row) for row in rows]

    @staticmethod
    def _summary_illustration_job_from_row(
        row: sqlite3.Row,
    ) -> SummaryIllustrationJob:
        values = dict(row)
        values["slots"] = json.loads(values["slots"])
        values["metrics"] = json.loads(values["metrics"])
        return SummaryIllustrationJob.model_validate(values)

    def load_summary_media(
        self,
        asset_id: str,
        version_id: str | None = None,
    ) -> list[SummaryMediaArtifact]:
        where = "asset_id = ?"
        parameters = [asset_id]
        if version_id is not None:
            self._validate_identifier(version_id, "summary-version")
            where += " AND version_id = ?"
            parameters.append(version_id)
        rows = (
            self._db()
            .execute(
                f"SELECT * FROM summary_media WHERE {where} ORDER BY created_at",
                tuple(parameters),
            )
            .fetchall()
        )
        media: list[SummaryMediaArtifact] = []
        for row in rows:
            values = dict(row)
            for field_name in (
                "target_heading_path",
                "source_types",
                "candidate_times",
            ):
                values[field_name] = json.loads(values[field_name])
            media.append(SummaryMediaArtifact.model_validate(values))
        return media
