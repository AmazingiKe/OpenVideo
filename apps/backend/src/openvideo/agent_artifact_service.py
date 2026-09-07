"""集中管理产物审批、权限授权、版本合并与撤销，避免耦合模型运行流程。"""

from __future__ import annotations

from typing import Any, Protocol

from openvideo.agent_permission_policy import PermissionPolicy
from openvideo.agent_registry import (
    MARKER_AGENT_ID,
    SUMMARY_AGENT_ID,
    AgentConflictError,
    AgentNotFoundError,
    AgentServiceError,
)
from openvideo.agent_tooling import (
    ARTIFACT_EVIDENCE_GATE_KEY,
    AgentRunContext,
    MarkerChangeOperation,
    marker_digest,
    rewrite_segment_references,
    transcript_digest,
)
from openvideo.core.agent_change_merge import merge_markdown
from openvideo.core.agent_evidence_models import (
    AgentEvidenceConfidence,
    AgentEvidenceWriteDecision,
)
from openvideo.core.agent_governance_models import (
    AgentPermissionContext,
    AgentPermissionGrant,
    AgentPermissionGrantScope,
    AgentPermissionOutcome,
    AgentResourceScope,
    AgentToolEffect,
    AgentToolPermissionPolicy,
)
from openvideo.core.agent_runtime_models import (
    AgentArtifact,
    AgentArtifactStatus,
    AgentChangeVersion,
)
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import MediaMarker, MediaSegment
from openvideo.core.summary_models import (
    SummaryDocumentCreate,
    SummaryIllustrationJob,
    SummaryMediaCreate,
    SummaryProject,
)
from openvideo.settings import Settings
from openvideo.summary_illustration_manager import SummaryIllustrationError
from openvideo.summary_manager import SummaryError, SummaryRevisionConflictError

MARKER_ARTIFACT_TYPE = "marker_changes"
SUMMARY_ARTIFACT_TYPE = "summary_edit"
SUMMARY_MEDIA_ARTIFACT_TYPE = "summary_media"
TRANSCRIPT_ARTIFACT_TYPE = "transcript_correction"


class SummaryDocumentService(Protocol):
    def project(self, asset_id: str) -> SummaryProject | None: ...

    def apply_agent_edit(
        self,
        document_id: str,
        expected_revision: int,
        markdown: str,
        suggested_children: list[SummaryDocumentCreate],
    ) -> tuple[Any, list[Any]]: ...

    def create_media(self, request: SummaryMediaCreate) -> Any: ...

    def restore_agent_change(
        self,
        document_id: str,
        expected_revision: int,
        markdown: str,
        remove_document_ids: list[str],
        remove_media_ids: list[str],
        restored_revision: int | None = None,
    ) -> Any: ...


class SummaryIllustrationService(Protocol):
    def create(
        self,
        asset_id: str,
        project_revision: int,
        planning_model_id: str,
    ) -> SummaryIllustrationJob: ...

    def start(self, job_id: str) -> None: ...


class AgentArtifactService:
    """以产物为边界维护正式数据的提交与撤销一致性。"""

    def __init__(
        self,
        library: MediaLibrary,
        settings: Settings,
        summary_documents: SummaryDocumentService,
        summary_illustrations: SummaryIllustrationService,
    ) -> None:
        self.library = library
        self.settings = settings
        self.summary_documents = summary_documents
        self.summary_illustrations = summary_illustrations

    def approve(self, artifact_id: str) -> AgentArtifact:
        artifact = self._require_artifact(artifact_id)
        if artifact.status != AgentArtifactStatus.PENDING:
            return artifact
        if block_reason := self._artifact_write_block_reason(artifact):
            raise AgentConflictError(block_reason)
        with self.library._lock:
            claimed = self.library.claim_agent_artifact(artifact_id)
            if claimed is None:
                return self._require_artifact(artifact_id)
            applied_artifact: AgentArtifact | None = None
            history_saved = False
            try:
                if claimed.agent_id == MARKER_AGENT_ID:
                    application_result = self._approve_marker_artifact(claimed)
                elif claimed.agent_id == SUMMARY_AGENT_ID:
                    application_result = self._approve_summary_artifact(claimed)
                else:
                    raise AgentConflictError("产物所属助手不存在")
                if isinstance(application_result, dict):
                    applied_artifact = claimed.model_copy(
                        update={
                            "payload": {
                                **claimed.payload,
                                "application_result": application_result,
                            }
                        }
                    )
                    self.library.save_agent_change_version(
                        AgentChangeVersion(
                            change_version_id=str(
                                application_result["change_version_id"]
                            ),
                            artifact_id=claimed.artifact_id,
                            run_id=claimed.run_id,
                            session_id=claimed.session_id,
                            agent_id=claimed.agent_id,
                            asset_id=claimed.asset_id,
                            result_type=claimed.result_type,
                            change_payload=claimed.payload,
                            application_result=application_result,
                        )
                    )
                    history_saved = True
                approved = self.library.finish_agent_artifact(
                    artifact_id,
                    AgentArtifactStatus.APPROVED,
                    application_result=(
                        application_result
                        if isinstance(application_result, dict)
                        else None
                    ),
                )
                if approved is None:
                    raise AgentConflictError("审批状态已被其他操作更新")
            except AgentConflictError as error:
                self._rollback_failed_approval(applied_artifact, history_saved)
                stale = self.library.finish_agent_artifact(
                    artifact_id,
                    AgentArtifactStatus.STALE,
                    str(error),
                )
                if stale is None:
                    raise AgentConflictError("审批状态已被其他操作更新") from error
                raise
            except Exception as error:
                self._rollback_failed_approval(applied_artifact, history_saved)
                failed = self.library.finish_agent_artifact(
                    artifact_id,
                    AgentArtifactStatus.FAILED,
                    str(error) or "应用审批结果失败",
                )
                if failed is None:
                    raise AgentConflictError("审批状态已被其他操作更新") from error
                raise
            self._start_initial_summary_illustration(approved)
            return approved

    def _start_initial_summary_illustration(self, artifact: AgentArtifact) -> None:
        """首次空白主文档成稿后异步配图，避免普通改稿重复扫描整篇笔记。"""

        payload = artifact.payload
        if (
            artifact.agent_id != SUMMARY_AGENT_ID
            or artifact.result_type != SUMMARY_ARTIFACT_TYPE
            or str(payload.get("original_markdown", "")).strip()
            or not str(payload.get("proposed_markdown", "")).strip()
        ):
            return
        application_result = payload.get("application_result")
        if (
            not isinstance(application_result, dict)
            or int(application_result.get("applied_change_count", 0)) < 1
        ):
            return
        try:
            document = self.library.load_summary_document(payload["document_id"])
            run = self.library.load_agent_run(artifact.run_id)
            project = self.summary_documents.project(artifact.asset_id)
            if (
                document is None
                or document.parent_document_id is not None
                or run is None
                or project is None
            ):
                return
            job = self.summary_illustrations.create(
                artifact.asset_id,
                project.revision,
                run.model_id,
            )
            self.summary_illustrations.start(job.job_id)
        except (SummaryError, SummaryIllustrationError, ValueError):
            return

    def approve_with_grant(
        self,
        artifact_id: str,
        grant_scope: AgentPermissionGrantScope,
    ) -> AgentArtifact:
        artifact = self._require_artifact(artifact_id)
        if artifact.status != AgentArtifactStatus.PENDING:
            return artifact
        approved = self.approve(artifact_id)
        if approved.status != AgentArtifactStatus.APPROVED:
            return approved
        grant = self._permission_grant_for_artifact(artifact, grant_scope)
        if grant.scope == AgentPermissionGrantScope.SESSION:
            self.library.save_agent_session_permission_grant(grant)
        elif grant.scope == AgentPermissionGrantScope.ALWAYS:
            existing_grants = self.settings.agent.always_allowed_grants
            if not any(
                self._same_permission_scope(existing, grant)
                for existing in existing_grants
            ):
                self.settings.agent = self.settings.agent.model_copy(
                    update={"always_allowed_grants": [*existing_grants, grant]}
                )
        return approved

    def reject(self, artifact_id: str) -> AgentArtifact:
        artifact = self._require_artifact(artifact_id)
        if artifact.status != AgentArtifactStatus.PENDING:
            return artifact
        return self.library.reject_agent_artifact(
            artifact_id
        ) or self._require_artifact(artifact_id)

    def undo(self, artifact_id: str) -> AgentArtifact:
        artifact = self._require_artifact(artifact_id)
        if artifact.status == AgentArtifactStatus.UNDONE:
            return artifact
        if artifact.status != AgentArtifactStatus.APPROVED:
            raise AgentConflictError("只有已应用的 Agent 变更可以撤销")
        with self.library._lock:
            claimed = self.library.claim_agent_artifact_undo(artifact_id)
            if claimed is None:
                return self._require_artifact(artifact_id)
            try:
                self._undo_claimed_artifact(claimed)
                application = claimed.payload.get("application_result")
                if not isinstance(application, dict):
                    raise AgentConflictError("变更版本缺少撤销信息")
                self.library.mark_agent_change_version_undone(
                    claimed.asset_id,
                    str(application["change_version_id"]),
                )
            except Exception as error:
                self.library.cancel_agent_artifact_undo(
                    artifact_id,
                    str(error) or "撤销 Agent 变更失败",
                )
                raise
            undone = self.library.finish_agent_artifact_undo(artifact_id)
            if undone is None:
                raise AgentConflictError("撤销状态已被其他操作更新")
            return undone

    def process_run_artifacts(
        self, context: AgentRunContext, artifacts: list[AgentArtifact]
    ) -> None:
        permission_context = AgentPermissionContext(
            request_id=context.run.request_key,
            session_id=context.session.session_id,
            resource_id=context.session.asset_id,
        )
        for artifact in artifacts:
            if artifact.status != AgentArtifactStatus.PENDING:
                continue
            if self._artifact_write_block_reason(artifact) is not None:
                continue
            policy = self._permission_policy_for_artifact(artifact)
            decision = PermissionPolicy.decide(
                self.settings.agent.permission_mode,
                policy,
                permission_context,
                [
                    *self.settings.agent.always_allowed_grants,
                    *self.library.load_agent_session_permission_grants(
                        context.session.session_id
                    ),
                ],
            )
            if decision.outcome != AgentPermissionOutcome.ALLOW:
                continue
            try:
                self.approve(artifact.artifact_id)
            except Exception:
                # approve 已把失败或版本冲突写入 artifact，Runtime 会返回稳定错误。
                continue

    @staticmethod
    def _permission_policy_for_artifact(
        artifact: AgentArtifact,
    ) -> AgentToolPermissionPolicy:
        return AgentToolPermissionPolicy(
            capability=f"artifact.apply.{artifact.result_type}",
            effect=AgentToolEffect.WRITE,
            resource_scope=AgentResourceScope.CURRENT_ITEM,
            reversible=False,
            bulk=True,
        )

    def _permission_grant_for_artifact(
        self,
        artifact: AgentArtifact,
        grant_scope: AgentPermissionGrantScope,
    ) -> AgentPermissionGrant:
        policy = self._permission_policy_for_artifact(artifact)
        run = self.library.load_agent_run(artifact.run_id)
        if run is None:
            raise AgentNotFoundError("产物所属运行不存在")
        return AgentPermissionGrant(
            capability=policy.capability,
            resource_scope=policy.resource_scope,
            resource_id=artifact.asset_id,
            scope=grant_scope,
            request_id=(
                run.request_key
                if grant_scope == AgentPermissionGrantScope.ONCE
                else None
            ),
            session_id=(
                artifact.session_id
                if grant_scope == AgentPermissionGrantScope.SESSION
                else None
            ),
        )

    @staticmethod
    def _same_permission_scope(
        existing: AgentPermissionGrant,
        requested: AgentPermissionGrant,
    ) -> bool:
        return (
            existing.capability == requested.capability
            and existing.resource_scope == requested.resource_scope
            and existing.resource_id == requested.resource_id
            and existing.scope == requested.scope
        )

    @staticmethod
    def _artifact_write_block_reason(artifact: AgentArtifact) -> str | None:
        if artifact.result_type == TRANSCRIPT_ARTIFACT_TYPE:
            return None
        try:
            decision = AgentEvidenceWriteDecision.model_validate(
                artifact.payload[ARTIFACT_EVIDENCE_GATE_KEY]
            )
        except (KeyError, ValueError):
            return "写入产物缺少程序验证过的证据决策"
        if not decision.allowed or decision.confidence == AgentEvidenceConfidence.LOW:
            return decision.reason
        return None

    def _approve_marker_artifact(self, artifact: AgentArtifact) -> dict[str, Any]:
        """视频 Agent 同时产出标记和字幕变更，写回必须按产物类型分派。"""

        if artifact.result_type == MARKER_ARTIFACT_TYPE:
            return self._approve_marker_changes(artifact)
        if artifact.result_type == TRANSCRIPT_ARTIFACT_TYPE:
            return self._approve_transcript_correction(artifact)
        raise AgentConflictError("视频 Agent 产物类型无效")

    def _approve_marker_changes(self, artifact: AgentArtifact) -> dict[str, Any]:
        current = self.library.load_markers(artifact.asset_id)
        base_digest = artifact.payload["snapshot_digest"]
        current_digest = marker_digest(current)
        markers_by_id = {marker.marker_id: marker for marker in current}
        segments = self.library.load_segments(artifact.asset_id)
        original_segments = list(segments)
        conflicts: list[str] = []
        applied_change_count = 0
        applied_change_indices: list[int] = []
        for position, change in enumerate(artifact.payload["changes"], start=1):
            before = [MediaMarker.model_validate(item) for item in change["before"]]
            source_ids = {item.marker_id for item in before}
            operation = MarkerChangeOperation(change["operation"])
            after = (
                MediaMarker.model_validate(change["after"]) if change["after"] else None
            )
            if operation == MarkerChangeOperation.CREATE:
                if after is not None and after.marker_id in markers_by_id:
                    conflicts.append(f"标记修改 {position} 的新增标记已存在")
                    continue
            elif any(markers_by_id.get(item.marker_id) != item for item in before):
                conflicts.append(f"标记修改 {position} 的来源标记已变化")
                continue
            if operation in {MarkerChangeOperation.DELETE, MarkerChangeOperation.MERGE}:
                for marker_id in source_ids:
                    markers_by_id.pop(marker_id, None)
            if operation == MarkerChangeOperation.UPDATE:
                markers_by_id.pop(before[0].marker_id, None)
            if after is not None:
                markers_by_id[after.marker_id] = after
            replacement = (
                after.marker_id
                if operation == MarkerChangeOperation.MERGE and after
                else None
            )
            segments = rewrite_segment_references(segments, source_ids, replacement)
            applied_change_count += 1
            applied_change_indices.append(position - 1)
        resolved = sorted(markers_by_id.values(), key=lambda item: item.start_seconds)
        if applied_change_count:
            self.library.replace_markers_and_segments(
                artifact.asset_id,
                resolved,
                segments,
            )
        return agent_application_result(
            rebased=current_digest != base_digest,
            applied_change_count=applied_change_count,
            skipped_conflicts=conflicts,
            base_version=base_digest,
            committed_version=marker_digest(resolved),
            applied_change_indices=applied_change_indices,
            undo={
                "before_segments": [
                    segment.model_dump(mode="json") for segment in original_segments
                ],
                "after_segments": [
                    segment.model_dump(mode="json") for segment in segments
                ],
            },
        )

    def _approve_summary_artifact(self, artifact: AgentArtifact) -> dict[str, Any]:
        payload = artifact.payload
        document = self.library.load_summary_document(payload["document_id"])
        if document is None or document.asset_id != artifact.asset_id:
            raise AgentConflictError("总结文档不存在或不属于当前笔记")
        base_revision = payload["base_revision"]
        if artifact.result_type == SUMMARY_MEDIA_ARTIFACT_TYPE:
            media = SummaryMediaCreate.model_validate(payload["media"])
            if document.markdown.count(media.insert_after) != 1:
                return agent_application_result(
                    rebased=document.revision != base_revision,
                    applied_change_count=0,
                    skipped_conflicts=["总结媒体的插入位置已变化"],
                    base_version=str(base_revision),
                    committed_version=str(document.revision),
                )
            try:
                media_result = self.summary_documents.create_media(
                    media.model_copy(update={"expected_revision": document.revision})
                )
            except SummaryRevisionConflictError as error:
                raise AgentConflictError("总结文档在提交时再次发生变化") from error
            except SummaryError as error:
                raise AgentServiceError(str(error)) from error
            committed_revision = (
                media_result[1].revision
                if isinstance(media_result, tuple)
                else document.revision + 1
            )
            return agent_application_result(
                rebased=document.revision != base_revision,
                applied_change_count=1,
                skipped_conflicts=[],
                base_version=str(base_revision),
                committed_version=str(committed_revision),
                undo={
                    "document_id": document.document_id,
                    "before_revision": document.revision,
                    "before_markdown": document.markdown,
                    "after_markdown": media_result[1].markdown,
                    "created_document_ids": [],
                    "created_media_ids": [media_result[0].media_id],
                }
                if isinstance(media_result, tuple)
                else None,
            )
        if artifact.result_type != SUMMARY_ARTIFACT_TYPE:
            raise AgentConflictError("总结审批结果类型无效")
        merge_result = merge_markdown(
            payload["original_markdown"],
            payload["proposed_markdown"],
            document.markdown,
        )
        children = [
            SummaryDocumentCreate.model_validate(child)
            for child in payload["suggested_subdocuments"]
        ]
        updated, committed_children = self.summary_documents.apply_agent_edit(
            document.document_id,
            document.revision,
            merge_result.markdown,
            children,
        )
        return agent_application_result(
            rebased=merge_result.rebased,
            applied_change_count=(
                merge_result.applied_change_count + len(committed_children)
            ),
            skipped_conflicts=list(merge_result.skipped_conflicts),
            base_version=str(base_revision),
            committed_version=str(updated.revision),
            undo={
                "document_id": document.document_id,
                "before_revision": document.revision,
                "before_markdown": document.markdown,
                "after_markdown": merge_result.markdown,
                "created_document_ids": [
                    child.document_id for child in committed_children
                ],
                "created_media_ids": [],
            },
        )

    def _approve_transcript_correction(self, artifact: AgentArtifact) -> dict[str, Any]:
        transcript = self.library.load_transcript(artifact.asset_id)
        if transcript is None:
            raise AgentConflictError("字幕不存在")
        base_digest = artifact.payload["transcript_digest"]
        current_digest = transcript_digest(transcript)
        segments = list(transcript.segments)
        conflicts: list[str] = []
        applied_change_count = 0
        applied_change_indices: list[int] = []
        for position, change in enumerate(artifact.payload["changes"], start=1):
            index = int(change["segment_index"])
            if index >= len(segments) or segments[index].text != change["before"]:
                conflicts.append(f"字幕修改 {position} 的原片段已变化")
                continue
            segments[index] = segments[index].model_copy(
                update={"text": change["after"]}
            )
            applied_change_count += 1
            applied_change_indices.append(position - 1)
        updated = transcript.model_copy(update={"segments": segments})
        if applied_change_count:
            self.library.save_transcript(updated)
        return agent_application_result(
            rebased=current_digest != base_digest,
            applied_change_count=applied_change_count,
            skipped_conflicts=conflicts,
            base_version=base_digest,
            committed_version=transcript_digest(updated),
            applied_change_indices=applied_change_indices,
        )

    def _undo_claimed_artifact(
        self,
        artifact: AgentArtifact,
        *,
        rollback: bool = False,
    ) -> None:
        application = artifact.payload.get("application_result")
        if not isinstance(application, dict):
            raise AgentConflictError("变更版本缺少撤销信息")
        if artifact.result_type == MARKER_ARTIFACT_TYPE:
            self._undo_marker_changes(artifact, application)
        elif artifact.result_type == TRANSCRIPT_ARTIFACT_TYPE:
            self._undo_transcript_correction(artifact, application)
        elif artifact.result_type in {
            SUMMARY_ARTIFACT_TYPE,
            SUMMARY_MEDIA_ARTIFACT_TYPE,
        }:
            self._undo_summary_change(application, rollback=rollback)
        else:
            raise AgentConflictError("此类 Agent 变更不支持撤销")

    def _rollback_failed_approval(
        self,
        applied_artifact: AgentArtifact | None,
        history_saved: bool,
    ) -> None:
        if applied_artifact is None:
            return
        application = applied_artifact.payload["application_result"]
        if int(application["applied_change_count"]) > 0:
            self._undo_claimed_artifact(applied_artifact, rollback=True)
        if history_saved:
            self.library.delete_agent_change_version(
                applied_artifact.asset_id,
                str(application["change_version_id"]),
            )

    def _undo_marker_changes(
        self,
        artifact: AgentArtifact,
        application: dict[str, Any],
    ) -> None:
        indices = [
            int(value) for value in application.get("applied_change_indices", [])
        ]
        undo = application.get("undo")
        if not isinstance(undo, dict):
            raise AgentConflictError("标记变更缺少撤销快照")
        before_segments = [
            MediaSegment.model_validate(value)
            for value in undo.get("before_segments", [])
        ]
        after_segments = [
            MediaSegment.model_validate(value)
            for value in undo.get("after_segments", [])
        ]
        current_segments = self.library.load_segments(artifact.asset_id)
        if current_segments != after_segments:
            raise AgentConflictError("时间线已有后续修改，不能整批撤销")
        markers_by_id = {
            marker.marker_id: marker
            for marker in self.library.load_markers(artifact.asset_id)
        }
        changes = artifact.payload["changes"]
        for index in indices:
            change = changes[index]
            before = [MediaMarker.model_validate(value) for value in change["before"]]
            after = (
                MediaMarker.model_validate(change["after"]) if change["after"] else None
            )
            operation = MarkerChangeOperation(change["operation"])
            if operation == MarkerChangeOperation.CREATE:
                if after is None or markers_by_id.get(after.marker_id) != after:
                    raise AgentConflictError("新增标记已有后续修改，不能整批撤销")
            elif operation == MarkerChangeOperation.UPDATE:
                if after is None or markers_by_id.get(after.marker_id) != after:
                    raise AgentConflictError("修改标记已有后续修改，不能整批撤销")
            elif operation == MarkerChangeOperation.DELETE:
                if any(item.marker_id in markers_by_id for item in before):
                    raise AgentConflictError("已删除标记被重新创建，不能整批撤销")
            elif (
                after is None
                or markers_by_id.get(after.marker_id) != after
                or any(item.marker_id in markers_by_id for item in before)
            ):
                raise AgentConflictError("合并标记已有后续修改，不能整批撤销")
        for index in reversed(indices):
            change = changes[index]
            before = [MediaMarker.model_validate(value) for value in change["before"]]
            after = (
                MediaMarker.model_validate(change["after"]) if change["after"] else None
            )
            if after is not None:
                markers_by_id.pop(after.marker_id, None)
            for marker in before:
                markers_by_id[marker.marker_id] = marker
        restored = sorted(
            markers_by_id.values(),
            key=lambda item: item.start_seconds,
        )
        self.library.replace_markers_and_segments(
            artifact.asset_id,
            restored,
            before_segments,
        )

    def _undo_transcript_correction(
        self,
        artifact: AgentArtifact,
        application: dict[str, Any],
    ) -> None:
        transcript = self.library.load_transcript(artifact.asset_id)
        if transcript is None:
            raise AgentConflictError("字幕不存在")
        segments = list(transcript.segments)
        indices = [
            int(value) for value in application.get("applied_change_indices", [])
        ]
        changes = artifact.payload["changes"]
        for index in indices:
            change = changes[index]
            segment_index = int(change["segment_index"])
            if (
                segment_index >= len(segments)
                or segments[segment_index].text != change["after"]
            ):
                raise AgentConflictError("字幕已有后续修改，不能整批撤销")
        for index in indices:
            change = changes[index]
            segment_index = int(change["segment_index"])
            segments[segment_index] = segments[segment_index].model_copy(
                update={"text": change["before"]}
            )
        self.library.save_transcript(
            transcript.model_copy(update={"segments": segments})
        )

    def _undo_summary_change(
        self,
        application: dict[str, Any],
        *,
        rollback: bool,
    ) -> None:
        undo = application.get("undo")
        if not isinstance(undo, dict):
            raise AgentConflictError("总结变更缺少撤销快照")
        document_id = str(undo["document_id"])
        document = self.library.load_summary_document(document_id)
        if document is None or document.markdown != undo["after_markdown"]:
            raise AgentConflictError("总结已有后续修改，不能整批撤销")
        try:
            self.summary_documents.restore_agent_change(
                document_id,
                document.revision,
                str(undo["before_markdown"]),
                [str(value) for value in undo["created_document_ids"]],
                [str(value) for value in undo["created_media_ids"]],
                restored_revision=(int(undo["before_revision"]) if rollback else None),
            )
        except SummaryRevisionConflictError as error:
            raise AgentConflictError(str(error)) from error

    def _require_artifact(self, artifact_id: str) -> AgentArtifact:
        try:
            artifact = self.library.load_agent_artifact(artifact_id)
        except ValueError as error:
            raise AgentNotFoundError("Agent 审批结果不存在") from error
        if artifact is None:
            raise AgentNotFoundError("Agent 审批结果不存在")
        return artifact


def agent_application_result(
    *,
    rebased: bool,
    applied_change_count: int,
    skipped_conflicts: list[str],
    base_version: str,
    committed_version: str,
    applied_change_indices: list[int] | None = None,
    undo: dict[str, object] | None = None,
) -> dict[str, object]:
    """审批卡只暴露版本与冲突摘要，不把敏感正文写入运行日志。"""

    result: dict[str, object] = {
        "change_version_id": f"agent-version-{uuid7().hex}",
        "rebased": rebased,
        "applied_change_count": applied_change_count,
        "skipped_conflicts": skipped_conflicts,
        "base_version": base_version,
        "committed_version": committed_version,
    }
    if applied_change_indices is not None:
        result["applied_change_indices"] = applied_change_indices
    if undo is not None:
        result["undo"] = undo
    return result
