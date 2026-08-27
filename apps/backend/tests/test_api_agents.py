from pathlib import Path

from fastapi.testclient import TestClient

from openvideo.core.agent_runtime_models import AgentModelResponse
from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import (
    MediaAsset,
    MediaAssetStatus,
    SourcePlatform,
)
from openvideo.settings import Settings
from openvideo.tools.llm import LiteLlmAgentAdapter
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
        tool_calling_mode="enabled",
    )
    return TestClient(create_app(Settings(library_path=tmp_path, ai_models=[model])))


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
    async def reply_without_required_tool(self, model, messages, tools, on_chunk):
        on_chunk("处理中")
        return AgentModelResponse(content="未调用工具")

    monkeypatch.setattr(LiteLlmAgentAdapter, "complete", reply_without_required_tool)
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
