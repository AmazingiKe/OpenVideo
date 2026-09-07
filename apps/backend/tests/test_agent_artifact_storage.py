from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from openvideo.core.agent_runtime_models import (
    AgentArtifact,
    AgentArtifactStatus,
    AgentRun,
    AgentRunCheckpoint,
    AgentRunCreate,
    AgentSession,
)
from openvideo.core.agent_governance_models import (
    AgentPermissionGrant,
    AgentPermissionGrantScope,
    AgentResourceScope,
)
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import MediaAsset, MediaAssetStatus, SourcePlatform


def create_artifact(library: MediaLibrary) -> AgentArtifact:
    asset = MediaAsset(
        asset_id=str(uuid7()),
        title="审批测试",
        source_url="https://example.com/video",
        source_platform=SourcePlatform.YOUTUBE,
        status=MediaAssetStatus.READY,
    )
    library.save(asset)
    session = AgentSession(
        session_id=f"session-{uuid7().hex}",
        agent_id="summary",
        asset_id=asset.asset_id,
        title="审批测试",
    )
    library.save_agent_session(session)
    run = AgentRun(
        run_id=f"run-{uuid7().hex}",
        session_id=session.session_id,
        request_key=f"request-{uuid7().hex}",
        model_id=f"model-{uuid7().hex}",
    )
    library.save_agent_run(run)
    artifact = AgentArtifact(
        artifact_id=f"artifact-{uuid7().hex}",
        run_id=run.run_id,
        session_id=session.session_id,
        agent_id="summary",
        asset_id=asset.asset_id,
        result_type="summary_edit",
        payload={"document_id": "document-test"},
    )
    library.save_agent_artifact(artifact)
    return artifact


def test_only_one_concurrent_approval_can_claim_an_artifact(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    try:
        artifact = create_artifact(library)

        with ThreadPoolExecutor(max_workers=2) as executor:
            claims = list(
                executor.map(
                    lambda _: library.claim_agent_artifact(artifact.artifact_id),
                    range(2),
                )
            )

        claimed = [claim for claim in claims if claim is not None]
        assert len(claimed) == 1
        assert claimed[0].status == AgentArtifactStatus.APPLYING
    finally:
        library.close()


def test_artifact_terminal_transition_requires_claim(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    try:
        artifact = create_artifact(library)

        assert (
            library.finish_agent_artifact(
                artifact.artifact_id, AgentArtifactStatus.APPROVED
            )
            is None
        )
        assert library.claim_agent_artifact(artifact.artifact_id) is not None
        approved = library.finish_agent_artifact(
            artifact.artifact_id, AgentArtifactStatus.APPROVED
        )

        assert approved is not None
        assert approved.status == AgentArtifactStatus.APPROVED
        assert library.reject_agent_artifact(artifact.artifact_id) is None
    finally:
        library.close()


def test_session_permission_grant_survives_library_reopen(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    artifact = create_artifact(library)
    grant = AgentPermissionGrant(
        capability="artifact.apply.summary_edit",
        resource_scope=AgentResourceScope.CURRENT_ITEM,
        resource_id=artifact.asset_id,
        scope=AgentPermissionGrantScope.SESSION,
        session_id=artifact.session_id,
    )
    library.save_agent_session_permission_grant(grant)
    library.close()

    reopened = MediaLibrary.open(tmp_path)
    try:
        assert reopened.load_agent_session_permission_grants(artifact.session_id) == [
            grant
        ]
    finally:
        reopened.close()


def test_agent_checkpoint_survives_library_reopen(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    artifact = create_artifact(library)
    checkpoint = AgentRunCheckpoint(
        run_id=artifact.run_id,
        session_id=artifact.session_id,
        request=AgentRunCreate(
            request_key=f"request-{uuid7().hex}",
            ai_model_id=f"model-{uuid7().hex}",
            content="继续分析视频",
        ),
        stage="running",
    )
    library.save_agent_run_checkpoint(checkpoint)
    library.close()

    reopened = MediaLibrary.open(tmp_path)
    try:
        assert reopened.load_agent_run_checkpoint(artifact.run_id) == checkpoint
        reopened.interrupt_agent_run_checkpoints()
        interrupted = reopened.load_agent_run_checkpoint(artifact.run_id)
        assert interrupted is not None
        assert interrupted.stage == "interrupted"
        assert interrupted.retry_allowed is True
    finally:
        reopened.close()


def test_legacy_checkpoint_columns_migrate_without_losing_request(tmp_path):
    from openvideo.core.agent_checkpoint_store import (
        open_agent_checkpoint_database,
        save_agent_checkpoint,
        load_agent_checkpoint,
    )

    path = tmp_path / "checkpoints.sqlite3"
    connection = open_agent_checkpoint_database(path)
    checkpoint = AgentRunCheckpoint(
        run_id=f"run-{uuid7().hex}",
        session_id=f"session-{uuid7().hex}",
        request=AgentRunCreate(
            request_key=f"request-{uuid7().hex}",
            ai_model_id=f"model-{uuid7().hex}",
            content="retry",
        ),
        retry_allowed=True,
    )
    save_agent_checkpoint(connection, checkpoint)
    connection.execute(
        "ALTER TABLE agent_run_checkpoints RENAME COLUMN retry_allowed TO resume_allowed"
    )
    connection.execute(
        "ALTER TABLE agent_run_checkpoints ADD COLUMN completed_steps TEXT NOT NULL DEFAULT '[]'"
    )
    connection.close()
    reopened = open_agent_checkpoint_database(path)
    try:
        assert load_agent_checkpoint(reopened, checkpoint.run_id) == checkpoint
        columns = {
            row["name"]
            for row in reopened.execute("PRAGMA table_info(agent_run_checkpoints)")
        }
        assert "retry_allowed" in columns
        assert "resume_allowed" not in columns
        assert "completed_steps" not in columns
        save_agent_checkpoint(reopened, checkpoint)
    finally:
        reopened.close()
