import hashlib
import json
import re
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pytest

from openvideo.agent_registry import AgentConflictError, build_run_content
from openvideo.agent_retrieval import retrieve_indexed_evidence
from openvideo.agent_runtime import new_agent_run
from openvideo.agent_service import AgentService
from openvideo.agent_tooling import (
    ARTIFACT_EVIDENCE_GATE_KEY,
    AgentRunContext,
    ProposeMarkerChangesInput,
    ProposeSummaryMediaInput,
    RunEvidenceState,
)
from openvideo.core.agent_runtime_models import (
    AgentArtifact,
    AgentArtifactStatus,
    AgentContextAttachment,
    AgentDefinition,
    AgentMode,
    AgentRunCreate,
    AgentSession,
    AgentSessionCreate,
    AgentToolCall,
)
from openvideo.core.agent_governance_models import AgentPermissionMode
from openvideo.core.agent_evidence_index import IndexedEvidenceDocument
from openvideo.core.agent_evidence_models import AgentEvidenceSource
from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import (
    MediaAsset,
    MediaAssetStatus,
    MediaSegment,
    SourcePlatform,
)
from openvideo.core.transcription_models import Transcript, TranscriptSegment
from openvideo.llm.agno_executor import AgnoAgentExecutor
from openvideo.llm.capability_resolver import CapabilityResolver
from openvideo.llm.events import (
    AgentExecutionResult,
    LlmAgentEvent,
    LlmAgentEventType,
)
from openvideo.llm.models_dev import ModelsDevCatalog
from openvideo.llm.model_profile import ModelLimits, ModelProfile
from openvideo.llm.probe_cache import ProbeCache
from openvideo.settings import Settings
from openvideo.ui.api import create_app


ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"
MODEL_ID = "model-01890f4c7a2b7cc298c4dc0c0c07398f"


@pytest.fixture(autouse=True)
def stub_agent_intent_router(monkeypatch):
    def route_request(_model, messages, *_args, **_kwargs):
        payload = json.loads(messages[-1]["content"])
        content = payload["user_request"]
        intent = payload["workflow_hint"]
        if intent is None and any(term in content for term in ("修改", "生成标记")):
            intent = "edit"
        if intent is None and any(term in content for term in ("插图", "图片", "GIF")):
            intent = "illustrate"
        intent = intent or "chat"
        model_role = (
            "complex"
            if intent != "chat" or payload["retrieval_scope"] == "library"
            else "fast"
        )
        return json.dumps(
            {
                "intent": intent,
                "model_role": model_role,
                "reason": "测试结构化路由",
            }
        )

    monkeypatch.setattr("openvideo.agent_intent_router.complete_text", route_request)


def evidence_gate(
    *, confidence: str = "medium", allowed: bool = True
) -> dict[str, object]:
    return {
        "allowed": allowed,
        "confidence": confidence,
        "reason": "测试证据决策",
        "evidence_ids": [],
        "source_versions": [],
    }


def create_client(tmp_path: Path) -> TestClient:
    library = MediaLibrary.initialize_directory(tmp_path)
    asset_directory = library.asset_directory(ASSET_ID)
    asset_directory.mkdir(parents=True, exist_ok=True)
    (asset_directory / "playback.mp4").write_bytes(b"video")
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="https://example.com/video",
            source_platform=SourcePlatform.YOUTUBE,
            title="测试视频",
            duration_seconds=60,
            status=MediaAssetStatus.READY,
            playback_path="playback.mp4",
        )
    )
    library.close()
    model = AiModelConfiguration(
        model_id=MODEL_ID,
        name="工具模型",
        litellm_model="openai/test",
        input_modalities=["text", "image"],
        capabilities={"tools": "enabled", "vision": "enabled"},
    )
    resolver = CapabilityResolver(
        models_dev=ModelsDevCatalog(tmp_path / "config" / "models-dev.json"),
        probe_cache=ProbeCache(tmp_path / "config" / "probes.json"),
    )
    return TestClient(
        create_app(
            Settings(library_path=tmp_path, ai_models=[model]),
            capability_resolver=resolver,
        )
    )


def test_definitions_and_sessions_use_only_unified_routes(tmp_path: Path):
    with create_client(tmp_path) as client:
        definitions = client.get("/api/agent-definitions")

        assert definitions.status_code == 200
        assert {item["definition"]["agent_id"] for item in definitions.json()} == {
            "marker",
            "summary",
            "transcript_correction",
        }
        assert client.get("/api/agent-sessions").json() == []

        created = client.post(
            "/api/agent-sessions",
            json={"agent_id": "marker", "asset_id": ASSET_ID},
        )

        assert created.status_code == 201
        assert created.json()["session_id"].startswith("session-")
        assert client.get("/api/marker-agent-sessions").status_code == 404
        assert client.get("/api/agent-jobs/obsolete").status_code == 404


def test_run_is_idempotent_and_sse_resumes_by_sequence(tmp_path: Path, monkeypatch):
    async def reply_without_required_tool(
        self,
        model,
        profile,
        definition,
        messages,
        registry,
        on_event,
        **_options,
    ):
        on_event(
            LlmAgentEvent(
                event_type=LlmAgentEventType.TEXT_DELTA,
                content="处理中",
            )
        )
        return AgentExecutionResult(content="未调用工具")

    monkeypatch.setattr(AgnoAgentExecutor, "run", reply_without_required_tool)
    with create_client(tmp_path) as client:
        session = client.post(
            "/api/agent-sessions",
            json={"agent_id": "marker", "asset_id": ASSET_ID},
        ).json()
        request_key = f"request-{uuid7().hex}"
        payload = {
            "request_key": request_key,
            "ai_model_id": MODEL_ID,
            "content": "检查标记",
        }

        first = client.post(
            f"/api/agent-sessions/{session['session_id']}/runs", json=payload
        )
        second = client.post(
            f"/api/agent-sessions/{session['session_id']}/runs", json=payload
        )

        assert first.status_code == 202
        assert second.json()["run_id"] == first.json()["run_id"]
        run_id = first.json()["run_id"]
        stream = client.get(f"/api/agent-runs/{run_id}/events")
        assert stream.status_code == 200
        assert "event: message.delta" in stream.text
        assert "event: run.failed" in stream.text
        events = client.get(
            f"/api/agent-runs/{run_id}/events",
            headers={"Last-Event-ID": "1"},
        )
        assert "id: 1\n" not in events.text
        run = client.get(f"/api/agent-runs/{run_id}").json()
        assert run["stage"] == "failed"
        assert run["error_code"] == "required_result_missing"


def test_natural_language_routes_to_marker_edit_without_ui_mode(
    tmp_path: Path,
    monkeypatch,
):
    captured: dict[str, object] = {}

    async def capture_definition(
        self,
        model,
        profile,
        definition,
        messages,
        registry,
        on_event,
        **_options,
    ):
        captured["definition"] = definition
        return AgentExecutionResult(content="等待生成标记建议")

    monkeypatch.setattr(AgnoAgentExecutor, "run", capture_definition)
    with create_client(tmp_path) as client:
        session = client.post(
            "/api/agent-sessions",
            json={"agent_id": "marker", "asset_id": ASSET_ID},
        ).json()
        run = client.post(
            f"/api/agent-sessions/{session['session_id']}/runs",
            json={
                "request_key": f"request-{uuid7().hex}",
                "ai_model_id": MODEL_ID,
                "content": "请生成标记建议",
            },
        ).json()
        client.get(f"/api/agent-runs/{run['run_id']}/events")
        state = client.get(f"/api/agent-sessions/{session['session_id']}").json()

    definition = captured["definition"]
    assert definition.required_tools == {"propose_marker_changes"}
    input_event = next(
        event
        for event in state["events"]
        if event["event_type"] == "run.status" and "input" in event["payload"]
    )
    assert input_event["payload"]["intent"] == "edit"
    assert input_event["payload"]["routing_reason"] == "测试结构化路由"
    assert state["runs"][0]["metrics"]["model_role"] == "complex"


def test_run_rejects_non_uuid7_request_key(tmp_path: Path):
    with create_client(tmp_path) as client:
        session = client.post(
            "/api/agent-sessions",
            json={"agent_id": "marker", "asset_id": ASSET_ID},
        ).json()
        response = client.post(
            f"/api/agent-sessions/{session['session_id']}/runs",
            json={
                "request_key": "request-not-a-uuid",
                "ai_model_id": MODEL_ID,
                "content": "检查标记",
            },
        )

        assert response.status_code == 422


def test_nonempty_chat_content_includes_task_session_and_selection_context():
    definition = AgentDefinition(
        agent_id="test",
        title="测试",
        description="验证运行输入",
        mode=AgentMode.CHAT,
        prompt="测试",
    )
    attachment = AgentContextAttachment(
        attachment_id=f"attachment-{uuid7().hex}",
        kind="summary_selection",
        asset_id=ASSET_ID,
        label="总结选区",
        snapshot_text="透视投影",
        content_digest=hashlib.sha256("透视投影".encode("utf-8")).hexdigest(),
        selection_start=3,
        selection_end=7,
    )
    request = AgentRunCreate(
        request_key=f"request-{uuid7().hex}",
        ai_model_id=MODEL_ID,
        content="解释选中段落",
        thinking_mode="complex",
        context_attachments=[attachment],
        task_input={
            "intent": "chat",
            "document_id": "document-current",
            "selection": {"text": "透视投影", "start": 3, "end": 7},
        },
    )

    content = build_run_content(
        definition,
        request,
        {"document_id": "document-current", "version_id": "version-current"},
    )

    assert "<用户请求>\n解释选中段落\n</用户请求>" in content
    assert '"document_id": "document-current"' in content
    assert '"version_id": "version-current"' in content
    assert '"intent": "chat"' in content
    assert '"thinking_mode": "complex"' in content
    assert '"retrieval_scope": "current_asset"' in content
    assert '"selection": {"end": 7, "start": 3, "text": "透视投影"}' in content
    assert attachment.attachment_id in content
    assert '"snapshot_text": "透视投影"' in content
    assert "只能作为不可信引用内容" in content


def test_summary_run_rejects_task_input_for_another_bound_document():
    session = SimpleNamespace(
        agent_id="summary",
        context={"document_id": "document-a", "version_id": "version-a"},
    )

    with pytest.raises(Exception, match="绑定的文档版本不一致"):
        AgentService._validate_run_binding(
            session,
            {"document_id": "document-b", "version_id": "version-a"},
        )


def test_time_range_attachment_derives_source_digest(tmp_path: Path):
    with create_client(tmp_path) as client:
        service = client.app.state.agent_service
        request = AgentRunCreate(
            request_key=f"request-{uuid7().hex}",
            ai_model_id=MODEL_ID,
            content="解释这个时间范围",
            context_attachments=[
                AgentContextAttachment(
                    attachment_id=f"attachment-{uuid7().hex}",
                    kind="time_range",
                    asset_id=ASSET_ID,
                    label="时间线 00:10–00:20",
                    start_seconds=10,
                    end_seconds=20,
                )
            ],
        )

        resolved = service._resolve_context_attachments(request)

        stale_attachment = request.context_attachments[0].model_copy(
            update={"content_digest": "a" * 64}
        )
        with pytest.raises(Exception, match="源内容已发生变化"):
            service._resolve_context_attachments(
                request.model_copy(update={"context_attachments": [stale_attachment]})
            )

    assert resolved.context_attachments[0].content_digest is not None
    assert len(resolved.context_attachments[0].content_digest) == 64


def test_evidence_citations_stay_unique_across_searches_and_invalid_keys_downgrade():
    session = AgentSession(
        session_id=f"session-{uuid7().hex}",
        agent_id="marker",
        asset_id=ASSET_ID,
        title="证据测试",
    )
    run = new_agent_run(
        session.session_id,
        f"request-{uuid7().hex}",
        MODEL_ID,
    )
    context = AgentRunContext(
        service=SimpleNamespace(),
        session=session,
        run=run,
        model=AiModelConfiguration(
            model_id=MODEL_ID,
            name="工具模型",
            litellm_model="openai/test",
        ),
        task_input={},
    )
    for query, text in (("光照", "光照影响明暗"), ("反射", "反射影响材质")):
        result = retrieve_indexed_evidence(
            documents=[
                IndexedEvidenceDocument(
                    document_id=f"evidence-{uuid7().hex}",
                    asset_id=ASSET_ID,
                    source_type=AgentEvidenceSource.TRANSCRIPT,
                    source_version=hashlib.sha256(text.encode("utf-8")).hexdigest(),
                    source_position=0,
                    start_seconds=5,
                    end_seconds=10,
                    title=None,
                    text=text,
                    relevance_score=0.8,
                    match_reasons=("测试召回",),
                )
            ],
            query=query,
            start_seconds=None,
            end_seconds=None,
            limit=4,
            duration_seconds=60,
        )
        context.evidence.record_search(result)

    citation_keys = [
        item.citation_key
        for search in context.evidence.searches
        for item in search.evidence_bundle.items
    ]
    assert citation_keys == ["E1", "E2"]
    valid = context.completion_payload("光照与反射分别有证据 [E1] [E2]")
    assert valid["citation_validation"]["valid"] is True
    assert len(valid["evidence_bundle"]["items"]) == 2
    invalid = context.completion_payload("引用了不存在的证据 [E99]")
    assert invalid["confidence"] == "low"
    assert invalid["answer_status"] == "provisional"
    assert invalid["citation_validation"]["invalid_citations"] == ["E99"]


def test_grounded_answer_chain_receives_context_and_structured_evidence(
    tmp_path: Path,
    monkeypatch,
):
    captured: dict[str, object] = {}

    async def answer_from_evidence(
        self,
        model,
        profile,
        definition,
        messages,
        registry,
        on_event,
        **_options,
    ):
        result = await registry.execute(
            AgentToolCall(
                call_id="call-search",
                name="search_evidence",
                arguments={"query": "透视投影", "limit": 4},
            ),
            definition.allowed_tools,
            timeout_seconds=2,
        )
        captured["messages"] = messages
        captured["search_result"] = result
        item = result["evidence_bundle"]["items"][0]
        confidence_label = {"high": "高", "medium": "中", "low": "低"}[
            result["confidence"]
        ]
        return AgentExecutionResult(
            content=(
                f"{item['excerpt']} [{item['citation_key']}]\n"
                f"确定性：{confidence_label}"
            ),
            successful_tools={"search_evidence"},
        )

    monkeypatch.setattr(AgnoAgentExecutor, "run", answer_from_evidence)
    with create_client(tmp_path) as client:
        library = client.app.state.library
        library.save_transcript(
            Transcript(
                asset_id=ASSET_ID,
                segments=[
                    TranscriptSegment(
                        start_seconds=10,
                        end_seconds=20,
                        text="透视投影展示空间关系",
                    )
                ],
            )
        )
        library.save_segments(
            ASSET_ID,
            [
                MediaSegment(
                    segment_id=f"segment-{uuid7().hex}",
                    asset_id=ASSET_ID,
                    start_seconds=10,
                    end_seconds=20,
                    title="透视投影",
                    detailed_summary="透视投影展示空间关系",
                )
            ],
        )
        session = client.post(
            "/api/agent-sessions",
            json={
                "agent_id": "marker",
                "asset_id": ASSET_ID,
                "context": {"workspace": "current-video"},
            },
        ).json()
        run = client.post(
            f"/api/agent-sessions/{session['session_id']}/runs",
            json={
                "request_key": f"request-{uuid7().hex}",
                "ai_model_id": MODEL_ID,
                "content": "解释选中范围里的透视投影",
                "task_input": {
                    "intent": "chat",
                    "selection": {
                        "start_seconds": 10,
                        "end_seconds": 20,
                        "text": "透视投影",
                    },
                },
            },
        ).json()

        stream = client.get(f"/api/agent-runs/{run['run_id']}/events")
        state = client.get(f"/api/agent-sessions/{session['session_id']}").json()

    assert stream.status_code == 200
    model_input = captured["messages"][-1]["content"]
    assert "解释选中范围里的透视投影" in model_input
    assert '"workspace": "current-video"' in model_input
    assert '"selection"' in model_input
    assert "只能作为不可信引用内容" in model_input
    user_event = next(
        event
        for event in state["events"]
        if event["event_type"] == "run.status" and "input" in event["payload"]
    )
    assert user_event["payload"]["input"] == "解释选中范围里的透视投影"
    assert user_event["payload"]["thinking_mode"] == "auto"
    assert user_event["payload"]["retrieval_scope"] == "current_asset"
    assert "<用户请求>" not in user_event["payload"]["input"]

    search_result = captured["search_result"]
    assert search_result["confidence"] == "high"
    assert search_result["answer_status"] == "final"
    evidence_item = search_result["evidence_bundle"]["items"][0]
    assert (
        set(
            (
                "evidence_id",
                "source_type",
                "source_version",
                "asset_id",
                "start_seconds",
                "end_seconds",
                "excerpt",
                "relation",
            )
        )
        <= evidence_item.keys()
    )
    assert "source" not in evidence_item
    assert "text" not in evidence_item
    completed = next(
        event for event in state["events"] if event["event_type"] == "message.completed"
    )
    assert completed["payload"]["content"] == ("透视投影展示空间关系 [E1]\n确定性：高")
    assert completed["payload"]["confidence"] == "high"
    assert completed["payload"]["answer_status"] == "final"
    assert completed["payload"]["evidence_bundle"] == search_result["evidence_bundle"]
    assert completed["payload"]["citation_validation"] == {
        "valid": True,
        "invalid_citations": [],
        "missing_citations": False,
    }
    completed_run = next(
        item for item in state["runs"] if item["run_id"] == run["run_id"]
    )
    assert completed_run["metrics"]["model_role"] == "fast"
    assert completed_run["metrics"]["selected_model_id"] == MODEL_ID


def test_service_approval_uses_single_claim_before_side_effect(
    tmp_path: Path,
    monkeypatch,
):
    calls: list[str] = []
    with create_client(tmp_path) as client:
        service = client.app.state.agent_service
        session = client.post(
            "/api/agent-sessions",
            json={"agent_id": "marker", "asset_id": ASSET_ID},
        ).json()
        run = new_agent_run(
            session["session_id"],
            f"request-{uuid7().hex}",
            MODEL_ID,
        )
        service.library.save_agent_run(run)
        artifact = AgentArtifact(
            artifact_id=f"artifact-{uuid7().hex}",
            run_id=run.run_id,
            session_id=session["session_id"],
            agent_id="marker",
            asset_id=ASSET_ID,
            result_type="test_changes",
            payload={ARTIFACT_EVIDENCE_GATE_KEY: evidence_gate()},
        )
        service.library.save_agent_artifact(artifact)
        monkeypatch.setattr(
            service.registry,
            "require",
            lambda _agent_id: SimpleNamespace(
                approver=lambda claimed: calls.append(claimed.artifact_id)
            ),
        )

        approved = service.approve(artifact.artifact_id)
        repeated = service.approve(artifact.artifact_id)

    assert approved.status == AgentArtifactStatus.APPROVED
    assert repeated.status == AgentArtifactStatus.APPROVED
    assert calls == [artifact.artifact_id]


def test_full_access_permission_auto_applies_completed_artifact(
    tmp_path: Path,
    monkeypatch,
):
    with create_client(tmp_path) as client:
        service = client.app.state.agent_service
        session = service.create_session(
            AgentSessionCreate(agent_id="marker", asset_id=ASSET_ID)
        )
        run = new_agent_run(
            session.session_id,
            f"request-{uuid7().hex}",
            MODEL_ID,
        )
        service.library.save_agent_run(run)
        artifact = AgentArtifact(
            artifact_id=f"artifact-{uuid7().hex}",
            run_id=run.run_id,
            session_id=session.session_id,
            agent_id="marker",
            asset_id=ASSET_ID,
            result_type="test_changes",
            payload={ARTIFACT_EVIDENCE_GATE_KEY: evidence_gate()},
        )
        service.library.save_agent_artifact(artifact)
        monkeypatch.setattr(
            service.registry,
            "require",
            lambda _agent_id: SimpleNamespace(approver=lambda _claimed: None),
        )
        service.settings.agent = service.settings.agent.model_copy(
            update={"permission_mode": AgentPermissionMode.FULL_ACCESS}
        )
        context = AgentRunContext(
            service=service,
            session=session,
            run=run,
            model=service.settings.ai_model(MODEL_ID),
            task_input={},
        )

        service._process_run_artifacts(context, [artifact])

        assert (
            service.library.load_agent_artifact(artifact.artifact_id).status
            == AgentArtifactStatus.APPROVED
        )


def test_low_confidence_artifact_cannot_apply_even_with_full_access(tmp_path: Path):
    with create_client(tmp_path) as client:
        service = client.app.state.agent_service
        session = service.create_session(
            AgentSessionCreate(agent_id="marker", asset_id=ASSET_ID)
        )
        run = new_agent_run(
            session.session_id,
            f"request-{uuid7().hex}",
            MODEL_ID,
        )
        service.library.save_agent_run(run)
        artifact = AgentArtifact(
            artifact_id=f"artifact-{uuid7().hex}",
            run_id=run.run_id,
            session_id=session.session_id,
            agent_id="marker",
            asset_id=ASSET_ID,
            result_type="marker_changes",
            payload={
                ARTIFACT_EVIDENCE_GATE_KEY: evidence_gate(
                    confidence="low", allowed=False
                )
            },
        )
        service.library.save_agent_artifact(artifact)
        service.settings.agent = service.settings.agent.model_copy(
            update={"permission_mode": AgentPermissionMode.FULL_ACCESS}
        )
        context = AgentRunContext(
            service=service,
            session=session,
            run=run,
            model=service.settings.ai_model(MODEL_ID),
            task_input={},
        )

        service._process_run_artifacts(context, [artifact])

        assert (
            service.library.load_agent_artifact(artifact.artifact_id).status
            == AgentArtifactStatus.PENDING
        )
        with pytest.raises(AgentConflictError, match="测试证据决策"):
            service.approve(artifact.artifact_id)


def test_low_confidence_marker_proposal_does_not_create_artifact(tmp_path: Path):
    with create_client(tmp_path) as client:
        service = client.app.state.agent_service
        context = SimpleNamespace(
            session=SimpleNamespace(asset_id=ASSET_ID),
            evidence=RunEvidenceState(),
            create_artifact=lambda *_args, **_kwargs: pytest.fail(
                "低确定性建议不应创建写入产物"
            ),
        )

        result = service._propose_marker_changes(
            context,
            ProposeMarkerChangesInput(
                changes=[
                    {
                        "operation": "create",
                        "start_seconds": 1,
                        "end_seconds": 2,
                        "reason": "测试建议",
                    }
                ]
            ),
        )

        assert result["ok"] is False
        assert result["error_code"] == "low_evidence_confidence"
        assert result[ARTIFACT_EVIDENCE_GATE_KEY]["confidence"] == "low"


def test_explicit_library_scope_retrieves_evidence_from_multiple_assets(
    tmp_path: Path,
    monkeypatch,
):
    captured: dict[str, object] = {}

    def reject_raw_evidence_scan(*_args, **_kwargs):
        raise AssertionError("Agent 检索不应逐素材读取原始业务文件")

    async def answer_from_library(
        self,
        model,
        profile,
        definition,
        messages,
        registry,
        on_event,
        **_options,
    ):
        result = await registry.execute(
            AgentToolCall(
                call_id="call-library-search",
                name="search_evidence",
                arguments={"query": "光照", "limit": 6},
            ),
            definition.allowed_tools,
            timeout_seconds=2,
        )
        captured["search_result"] = result
        return AgentExecutionResult(
            content="两个视频都讨论了光照 [E1] [E2]",
            successful_tools={"search_evidence"},
        )

    monkeypatch.setattr(AgnoAgentExecutor, "run", answer_from_library)
    second_asset_id = str(uuid7())
    with create_client(tmp_path) as client:
        library = client.app.state.library
        second_asset_directory = library.asset_directory(second_asset_id)
        second_asset_directory.mkdir(parents=True, exist_ok=True)
        (second_asset_directory / "playback.mp4").write_bytes(b"video")
        library.save(
            MediaAsset(
                asset_id=second_asset_id,
                source_url="https://example.com/second-video",
                source_platform=SourcePlatform.YOUTUBE,
                title="第二个视频",
                duration_seconds=90,
                status=MediaAssetStatus.READY,
                playback_path="playback.mp4",
            )
        )
        for asset_id, text in (
            (ASSET_ID, "基础光照决定明暗关系"),
            (second_asset_id, "全局光照影响间接反射"),
        ):
            library.save_transcript(
                Transcript(
                    asset_id=asset_id,
                    segments=[
                        TranscriptSegment(
                            start_seconds=5,
                            end_seconds=15,
                            text=text,
                        )
                    ],
                )
            )
        monkeypatch.setattr(
            library,
            "load_transcript",
            reject_raw_evidence_scan,
        )
        monkeypatch.setattr(
            library,
            "load_segments",
            reject_raw_evidence_scan,
        )
        session = client.post(
            "/api/agent-sessions",
            json={"agent_id": "marker", "asset_id": ASSET_ID},
        ).json()
        run = client.post(
            f"/api/agent-sessions/{session['session_id']}/runs",
            json={
                "request_key": f"request-{uuid7().hex}",
                "ai_model_id": MODEL_ID,
                "content": "比较资料库中不同视频对光照的说明",
                "retrieval_scope": "library",
            },
        ).json()
        client.get(f"/api/agent-runs/{run['run_id']}/events")

    search_result = captured["search_result"]
    evidence_asset_ids = {
        item["asset_id"] for item in search_result["evidence_bundle"]["items"]
    }
    assert evidence_asset_ids == {ASSET_ID, second_asset_id}


def test_marker_run_mode_separates_questions_from_change_proposals(tmp_path: Path):
    with create_client(tmp_path) as client:
        service = client.app.state.agent_service
        registered = service.registry.require("marker")
        profile = service.capability_resolver.resolve(
            service.settings.ai_model(MODEL_ID)
        )

        question_definition = registered.run_definition(
            registered.definition,
            AgentRunCreate(
                request_key=f"request-{uuid7().hex}",
                ai_model_id=MODEL_ID,
                content="这个课程主要讲什么？",
            ),
            profile,
        )
        proposal_definition = registered.run_definition(
            registered.definition,
            AgentRunCreate(
                request_key=f"request-{uuid7().hex}",
                ai_model_id=MODEL_ID,
                content="找出所有结论并生成范围标记",
                task_input={"intent": "edit"},
            ),
            profile,
        )

        assert question_definition.allowed_tools == (
            "search_evidence",
            "inspect_frames",
        )
        assert question_definition.required_tools == {"search_evidence"}
        assert question_definition.requires_approval is False
        assert "propose_marker_changes" not in question_definition.allowed_tools
        assert proposal_definition.allowed_tools == registered.definition.allowed_tools
        assert proposal_definition.required_tools == {"propose_marker_changes"}
        assert proposal_definition.requires_approval is True


def test_summary_media_mode_requires_inspected_visual_toolchain(tmp_path: Path):
    with create_client(tmp_path) as client:
        service = client.app.state.agent_service
        registered = service.registry.require("summary")
        profile = service.capability_resolver.resolve(
            service.settings.ai_model(MODEL_ID)
        )

        definition = registered.run_definition(
            registered.definition,
            AgentRunCreate(
                request_key=f"request-{uuid7().hex}",
                ai_model_id=MODEL_ID,
                content="为核心概念选择关键画面",
                task_input={"intent": "illustrate"},
            ),
            profile,
        )

        assert definition.allowed_tools == (
            "search_evidence",
            "inspect_frames",
            "read_summary_document",
            "propose_summary_media",
        )
        assert definition.required_capabilities == {"tools", "vision"}
        assert definition.required_tools == {"propose_summary_media"}
        assert definition.requires_approval is True
        assert definition.result_type == "summary_media"


def test_summary_media_proposal_uses_an_inspected_candidate_before_approval(
    tmp_path: Path,
    monkeypatch,
):
    monkeypatch.setattr(
        "openvideo.summary_manager.CapabilityResolver.resolve",
        lambda *_args, **_kwargs: ModelProfile(
            provider="openai",
            model="test",
            limits=ModelLimits(),
        ),
    )
    monkeypatch.setattr(
        "openvideo.summary_manager.litellm.token_counter",
        lambda **_kwargs: 1_000,
    )

    def complete_summary(_model, messages, *_args, **_kwargs):
        if "规划" in messages[0]["content"]:
            return json.dumps(
                {
                    "documents": [
                        {"key": "root", "title": "测试视频", "parent_key": None}
                    ]
                }
            )
        match = re.search(r"<允许路径表>\n(.*?)\n</允许路径表>", messages[1]["content"])
        assert match is not None
        path = json.loads(match.group(1))[0]["relative_path"]
        return json.dumps(
            {"documents": [{"relative_path": path, "markdown": "# 测试视频"}]}
        )

    monkeypatch.setattr("openvideo.summary_manager.complete_text", complete_summary)
    with create_client(tmp_path) as client:
        library = client.app.state.library
        library.save_transcript(
            Transcript(
                asset_id=ASSET_ID,
                segments=[
                    TranscriptSegment(
                        start_seconds=0,
                        end_seconds=20,
                        text="这里展示透视投影示意图。",
                    )
                ],
            )
        )
        generation = client.post(
            f"/api/media/assets/{ASSET_ID}/summary-documents/generate",
            json={
                "ai_model_id": MODEL_ID,
                "preset_id": "knowledge_notes",
                "detail": "standard",
                "output_language": "zh-CN",
            },
        ).json()
        document = generation["documents"][0]
        service = client.app.state.agent_service
        created_artifact: AgentArtifact | None = None

        def create_artifact(result_type: str, payload: dict) -> AgentArtifact:
            nonlocal created_artifact
            created_artifact = AgentArtifact(
                artifact_id=f"artifact-{uuid7().hex}",
                run_id=f"run-{uuid7().hex}",
                session_id=f"session-{uuid7().hex}",
                agent_id="summary",
                asset_id=ASSET_ID,
                result_type=result_type,
                payload=payload,
            )
            return created_artifact

        evidence_state = RunEvidenceState(
            evidence_read=True,
            frames_inspected=True,
            summary_read=True,
            inspected_frame_times=[12.5],
            inspected_frame_ranges=[(10, 15)],
        )
        evidence_state.record_search(
            retrieve_indexed_evidence(
                documents=[
                    IndexedEvidenceDocument(
                        document_id=f"evidence-{uuid7().hex}",
                        asset_id=ASSET_ID,
                        source_type=AgentEvidenceSource.VISUAL,
                        source_version=hashlib.sha256(b"frame").hexdigest(),
                        source_position=0,
                        start_seconds=10,
                        end_seconds=15,
                        title=None,
                        text="画面展示透视投影示意图",
                        relevance_score=0.8,
                        match_reasons=("画面证据",),
                    )
                ],
                query="透视投影示意图",
                start_seconds=10,
                end_seconds=15,
                limit=4,
                duration_seconds=20,
            )
        )
        context = SimpleNamespace(
            session=SimpleNamespace(
                asset_id=ASSET_ID,
                context={"version_id": document["version_id"]},
            ),
            evidence=evidence_state,
            create_artifact=create_artifact,
        )
        rejected = service._propose_summary_media(
            context,
            ProposeSummaryMediaInput(
                document_id=document["document_id"],
                expected_revision=document["revision"],
                media_type="image",
                start_seconds=13,
                insert_after="# 测试视频",
                caption="未经确认的画面",
                reason="该时间点没有对应候选帧。",
                confidence=0.9,
            ),
        )
        result = service._propose_summary_media(
            context,
            ProposeSummaryMediaInput(
                document_id=document["document_id"],
                expected_revision=document["revision"],
                media_type="image",
                start_seconds=12.5,
                insert_after="# 测试视频",
                caption="透视投影示意图",
                reason="画面完整展示正文涉及的空间结构。",
                confidence=0.9,
            ),
        )

        assert rejected == {
            "ok": False,
            "error": "图片时间点必须来自已检查的候选画面",
        }
        assert result["ok"] is True
        assert created_artifact is not None
        requests = []
        monkeypatch.setattr(
            service.summary_documents,
            "create_media",
            lambda request: requests.append(request),
        )

        service._approve_summary_artifact(created_artifact)

        assert len(requests) == 1
        assert requests[0].start_seconds == 12.5
        assert requests[0].caption == "透视投影示意图"
