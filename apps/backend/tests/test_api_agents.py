import json
import re
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pytest

from openvideo.agent_registry import build_run_content
from openvideo.agent_service import AgentService
from openvideo.agent_tooling import ProposeSummaryMediaInput, RunEvidenceState
from openvideo.core.agent_runtime_models import (
    AgentArtifact,
    AgentDefinition,
    AgentMode,
    AgentRunCreate,
    AgentToolCall,
)
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
    request = AgentRunCreate(
        request_key=f"request-{uuid7().hex}",
        ai_model_id=MODEL_ID,
        content="解释选中段落",
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
    assert '"selection": {"end": 7, "start": 3, "text": "透视投影"}' in content
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

        context = SimpleNamespace(
            session=SimpleNamespace(
                asset_id=ASSET_ID,
                context={"version_id": document["version_id"]},
            ),
            evidence=RunEvidenceState(
                evidence_read=True,
                frames_inspected=True,
                summary_read=True,
                inspected_frame_times=[12.5],
                inspected_frame_ranges=[(10, 15)],
            ),
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
