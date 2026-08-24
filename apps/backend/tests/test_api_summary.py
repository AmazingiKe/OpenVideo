import json
import re
import sqlite3
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

from openvideo.core.agent_runtime_models import AgentModelResponse, AgentToolCall
from openvideo.core.ai_models import TEXT_INPUT_MODALITY, AiModelConfiguration
from openvideo.core.transcription_models import Transcript, TranscriptSegment
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import (
    MediaAsset,
    MediaAssetStatus,
    MediaSegment,
    SourcePlatform,
)
from openvideo.settings import Settings
from openvideo.ui.api import create_app


ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"
MODEL_ID = "model-01890f4c7a2b7cc298c4dc0c0c07398f"


def create_client(tmp_path: Path, with_model: bool = False) -> TestClient:
    library = MediaLibrary.initialize_directory(tmp_path)
    asset_directory = library.asset_directory(ASSET_ID)
    asset_directory.mkdir(parents=True, exist_ok=True)
    (asset_directory / "playback.mp4").write_bytes(b"video")
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="https://www.bilibili.com/video/BV1xx411c7mD",
            source_platform=SourcePlatform.BILIBILI,
            source_video_id="BV1xx411c7mD",
            title="测试课程",
            duration_seconds=60,
            status=MediaAssetStatus.READY,
            playback_path="playback.mp4",
        )
    )
    library.save_transcript(
        Transcript(
            asset_id=ASSET_ID,
            segments=[
                TranscriptSegment(start_seconds=0, end_seconds=10, text="核心概念")
            ],
        )
    )
    library.save_segments(
        ASSET_ID,
        [
            MediaSegment(
                segment_id="segment-01890f4c7a2b7cc298c4dc0c0c07398f",
                asset_id=ASSET_ID,
                start_seconds=0,
                end_seconds=10,
                title="第一章",
                detailed_summary="核心概念说明",
            )
        ],
    )
    library.close()
    models = (
        [
            AiModelConfiguration(
                model_id=MODEL_ID,
                name="测试模型",
                litellm_model="openai/test",
                api_key="test",
                input_modalities=[TEXT_INPUT_MODALITY],
            )
        ]
        if with_model
        else []
    )
    return TestClient(create_app(Settings(library_path=tmp_path, ai_models=models)))


def generate_documents(client: TestClient, children: bool = False):
    response = client.post(
        f"/api/media/assets/{ASSET_ID}/summary-documents/generate",
        json={
            "detail": "standard",
            "create_subdocuments": children,
            "subdocument_mode": "chapters",
        },
    )
    assert response.status_code == 201
    return response.json()


def test_analysis_strategy_presets_are_resolved(tmp_path: Path):
    with create_client(tmp_path) as client:
        response = client.get("/api/analysis-strategies")

    assert response.status_code == 200
    presets = response.json()
    assert presets[0]["name"] == "课程笔记"
    assert presets[0]["strategy"]["weights"]["core_concepts"] == 90


def test_summary_generation_enforces_one_root_and_one_child_level(tmp_path: Path):
    with create_client(tmp_path) as client:
        documents = generate_documents(client, children=True)
        root = next(item for item in documents if item["parent_document_id"] is None)
        child = next(
            item for item in documents if item["parent_document_id"] is not None
        )
        duplicate = client.post(
            f"/api/media/assets/{ASSET_ID}/summary-documents/generate",
            json={},
        )
        nested = client.post(
            f"/api/summary-documents/{child['document_id']}/children",
            json={"title": "不允许的孙文档", "markdown": ""},
        )

    assert root["document_id"].startswith("document-")
    assert len(root["document_id"]) == len("document-") + 32
    assert child["parent_document_id"] == root["document_id"]
    assert duplicate.status_code == 409
    assert nested.status_code == 409


def test_summary_generation_uses_selected_ai_model(tmp_path: Path, monkeypatch):
    response_payload = {
        "title": "AI 课程总结",
        "markdown": "# AI 课程总结\n\n模型整理的核心结论。",
        "subdocuments": [{"title": "第一章", "markdown": "# 第一章\n\n章节内容。\n"}],
    }
    monkeypatch.setattr(
        "openvideo.summary_manager.complete_text",
        lambda *args, **kwargs: json.dumps(response_payload, ensure_ascii=False),
    )
    with create_client(tmp_path, with_model=True) as client:
        response = client.post(
            f"/api/media/assets/{ASSET_ID}/summary-documents/generate",
            json={
                "ai_model_id": MODEL_ID,
                "detail": "detailed",
                "create_subdocuments": True,
                "subdocument_mode": "chapters",
            },
        )

    assert response.status_code == 201
    documents = response.json()
    root = next(item for item in documents if item["parent_document_id"] is None)
    child = next(item for item in documents if item["parent_document_id"] is not None)
    assert root["title"] == "AI 课程总结"
    assert "模型整理的核心结论" in root["markdown"]
    assert f"docs/{child['document_id']}.md" in root["markdown"]
    assert child["title"] == "第一章"


def test_summary_document_update_detects_revision_conflict(tmp_path: Path):
    with create_client(tmp_path) as client:
        document = generate_documents(client)[0]
        first = client.patch(
            f"/api/summary-documents/{document['document_id']}",
            json={"expected_revision": 1, "markdown": "# 新内容\n"},
        )
        conflict = client.patch(
            f"/api/summary-documents/{document['document_id']}",
            json={"expected_revision": 1, "markdown": "# 旧覆盖\n"},
        )

    assert first.status_code == 200
    assert first.json()["revision"] == 2
    assert conflict.status_code == 409


def test_summary_agent_stream_persists_proposal_and_requires_acceptance(
    tmp_path: Path,
    monkeypatch,
):
    responses = [
        AgentModelResponse(
            tool_calls=[
                AgentToolCall(
                    call_id="call-proposal",
                    name="propose_summary_change",
                    arguments={
                        "proposed_markdown": "# Agent 修改\n",
                        "explanation": "精简章节",
                        "media_suggestions": [
                            {
                                "media_type": "image",
                                "start_seconds": 2,
                                "insert_after": "# Agent 修改",
                                "caption": "关键画面",
                            }
                        ],
                    },
                )
            ]
        ),
        AgentModelResponse(content="已创建待审批的修改建议。"),
    ]

    async def complete(_adapter, _model, _messages, _tools, on_chunk):
        response = responses.pop(0)
        if response.content:
            on_chunk(response.content)
        return response

    monkeypatch.setattr(
        "openvideo.summary_manager.LiteLlmAgentAdapter.complete", complete
    )
    with create_client(tmp_path, with_model=True) as client:
        document = generate_documents(client)[0]
        session = client.get(
            f"/api/media/assets/{ASSET_ID}/summary-agent-sessions"
        ).json()[0]
        run = client.post(
            f"/api/summary-agent-sessions/{session['session']['session_id']}/messages",
            json={
                "document_id": document["document_id"],
                "expected_revision": document["revision"],
                "content": "请精简章节",
                "ai_model_id": MODEL_ID,
                "selection": None,
            },
        )
        events = client.get(f"/api/agent-runs/{run.json()['run_id']}/events")
        state = client.get(
            f"/api/summary-agent-sessions/{session['session']['session_id']}"
        ).json()
        proposal = state["proposals"][0]
        before_accept = client.get(
            f"/api/media/assets/{ASSET_ID}/summary-documents"
        ).json()[0]
        accepted = client.post(
            f"/api/summary-edit-proposals/{proposal['proposal_id']}/accept"
        )
        after_accept = client.get(
            f"/api/media/assets/{ASSET_ID}/summary-documents"
        ).json()[0]

    assert run.status_code == 202
    assert "event: proposal" in events.text
    assert "event: assistant_message" in events.text
    assert state["session"]["title"] == "请精简章节"
    assert proposal["media_suggestions"][0]["suggestion_id"].startswith("suggestion-")
    assert before_accept["markdown"] != "# Agent 修改\n"
    assert accepted.status_code == 200
    assert after_accept["markdown"] == "# Agent 修改\n"


def test_summary_agent_supports_multiple_histories(tmp_path: Path):
    with create_client(tmp_path) as client:
        document = generate_documents(client)[0]
        initial = client.get(
            f"/api/media/assets/{ASSET_ID}/summary-agent-sessions"
        ).json()
        created = client.post(
            f"/api/media/assets/{ASSET_ID}/summary-agent-sessions",
            json={"document_id": document["document_id"]},
        )
        histories = client.get(
            f"/api/media/assets/{ASSET_ID}/summary-agent-sessions"
        ).json()
        deleted = client.delete(
            f"/api/summary-agent-sessions/{initial[0]['session']['session_id']}"
        )
        last_delete = client.delete(
            f"/api/summary-agent-sessions/{created.json()['session']['session_id']}"
        )

    assert created.status_code == 201
    assert created.json()["session"]["title"] == document["title"]
    assert len(histories) == 2
    assert deleted.status_code == 204
    assert last_delete.status_code == 409


def test_summary_agent_uses_only_the_selected_history_context(
    tmp_path: Path,
    monkeypatch,
):
    completion_messages: list[list[dict[str, object]]] = []

    async def complete(_adapter, _model, messages, _tools, on_chunk):
        completion_messages.append(messages)
        on_chunk("自然语言回复")
        return AgentModelResponse(content="自然语言回复")

    monkeypatch.setattr(
        "openvideo.summary_manager.LiteLlmAgentAdapter.complete", complete
    )
    with create_client(tmp_path, with_model=True) as client:
        document = generate_documents(client)[0]
        first_session = client.get(
            f"/api/media/assets/{ASSET_ID}/summary-agent-sessions"
        ).json()[0]
        for content in ("第一轮", "第二轮"):
            run = client.post(
                f"/api/summary-agent-sessions/"
                f"{first_session['session']['session_id']}/messages",
                json={
                    "document_id": document["document_id"],
                    "expected_revision": document["revision"],
                    "content": content,
                    "ai_model_id": MODEL_ID,
                    "selection": None,
                },
            ).json()
            client.get(f"/api/agent-runs/{run['run_id']}/events")
        second_session = client.post(
            f"/api/media/assets/{ASSET_ID}/summary-agent-sessions",
            json={"document_id": document["document_id"]},
        ).json()["session"]
        isolated_run = client.post(
            f"/api/summary-agent-sessions/{second_session['session_id']}/messages",
            json={
                "document_id": document["document_id"],
                "expected_revision": document["revision"],
                "content": "独立历史",
                "ai_model_id": MODEL_ID,
                "selection": None,
            },
        ).json()
        client.get(f"/api/agent-runs/{isolated_run['run_id']}/events")
        isolated_state = client.get(
            f"/api/summary-agent-sessions/{second_session['session_id']}"
        ).json()

    assert completion_messages[1][1]["content"] == "第一轮"
    assert completion_messages[1][2]["role"] == "assistant"
    assert len(completion_messages[2]) == 2
    assert isolated_state["proposals"] == []
    assert any(
        event["event_type"] == "assistant/message"
        and event["payload"]["content"] == "自然语言回复"
        for event in isolated_state["events"]
    )


def test_summary_project_exports_stable_relative_paths(tmp_path: Path):
    with create_client(tmp_path) as client:
        documents = generate_documents(client, children=True)
        root = next(item for item in documents if item["parent_document_id"] is None)
        child = next(
            item for item in documents if item["parent_document_id"] is not None
        )
        first = client.post(f"/api/media/assets/{ASSET_ID}/summary-exports")
        second = client.post(f"/api/media/assets/{ASSET_ID}/summary-exports")

    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["export_id"] != second.json()["export_id"]
    file_name = first.json()["file_name"]
    assert re.fullmatch(
        r"summary-\d{8}-\d{6}-\d{3}-export-[0-9a-f]{32}\.zip",
        file_name,
    )
    export_path = tmp_path / "assets" / ASSET_ID / first.json()["relative_path"]
    assert export_path.is_file()
    assert len(list(export_path.parent.glob("*.zip"))) == 2
    with zipfile.ZipFile(export_path) as archive:
        names = set(archive.namelist())
        assert names == {"index.md", f"docs/{child['document_id']}.md", "manifest.json"}
        assert f"docs/{child['document_id']}.md" in archive.read("index.md").decode()
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["root_document_id"] == root["document_id"]
        assert re.search(r"[+-]\d{2}:\d{2}$", manifest["exported_at"])


def test_summary_files_are_source_of_truth_and_stale_save_conflicts(tmp_path: Path):
    with create_client(tmp_path) as client:
        document = generate_documents(client)[0]
        summary_directory = tmp_path / "assets" / ASSET_ID / "summary"
        markdown_path = summary_directory / "index.md"
        manifest_path = summary_directory / "manifest.json"
        before_markdown_mtime = markdown_path.stat().st_mtime_ns
        before_manifest_mtime = manifest_path.stat().st_mtime_ns

        loaded = client.get(f"/api/media/assets/{ASSET_ID}/summary-documents")
        assert loaded.status_code == 200
        assert markdown_path.stat().st_mtime_ns == before_markdown_mtime
        assert manifest_path.stat().st_mtime_ns == before_manifest_mtime

        markdown_path.write_text("# 外部修改\n", encoding="utf-8")
    with TestClient(create_app(Settings(library_path=tmp_path))) as reopened:
        refreshed = reopened.get(
            f"/api/media/assets/{ASSET_ID}/summary-documents"
        ).json()[0]
        conflict = reopened.patch(
            f"/api/summary-documents/{document['document_id']}",
            json={"expected_revision": document["revision"], "markdown": "# 旧草稿\n"},
        )

    assert refreshed["markdown"] == "# 外部修改\n"
    assert refreshed["revision"] == document["revision"] + 1
    assert conflict.status_code == 409
    assert markdown_path.read_text(encoding="utf-8") == "# 外部修改\n"
    assert manifest_path.stat().st_mtime_ns == before_manifest_mtime


def test_summary_manifest_contains_paths_and_no_markdown_body(tmp_path: Path):
    with create_client(tmp_path) as client:
        documents = generate_documents(client, children=True)

    summary_directory = tmp_path / "assets" / ASSET_ID / "summary"
    manifest = json.loads(
        (summary_directory / "manifest.json").read_text(encoding="utf-8")
    )
    assert manifest["format_version"] == 1
    assert "markdown" not in json.dumps(manifest)
    root = next(item for item in documents if item["parent_document_id"] is None)
    child = next(item for item in documents if item["parent_document_id"] is not None)
    assert root["relative_path"] == "index.md"
    assert child["relative_path"] == f"docs/{child['document_id']}.md"
    assert (summary_directory / child["relative_path"]).is_file()


def test_gif_default_range_must_fit_video_duration(tmp_path: Path):
    with create_client(tmp_path) as client:
        document = generate_documents(client)[0]
        response = client.post(
            "/api/summary-media",
            json={
                "document_id": document["document_id"],
                "expected_revision": document["revision"],
                "media_type": "gif",
                "start_seconds": 58,
                "end_seconds": None,
                "caption": "片尾",
            },
        )

    assert response.status_code == 422
    assert response.json()["detail"] == "媒体时间范围超出视频范围"


def test_child_media_uses_summary_assets_and_parent_relative_link(
    tmp_path: Path,
    monkeypatch,
):
    def write_media(_playback, output_path, *_args, **_kwargs):
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"image")

    monkeypatch.setattr("openvideo.summary_manager.generate_summary_media", write_media)
    with create_client(tmp_path) as client:
        documents = generate_documents(client, children=True)
        child = next(
            item for item in documents if item["parent_document_id"] is not None
        )
        response = client.post(
            "/api/summary-media",
            json={
                "document_id": child["document_id"],
                "expected_revision": child["revision"],
                "media_type": "image",
                "start_seconds": 1,
                "end_seconds": None,
                "caption": "关键画面",
            },
        )

    assert response.status_code == 201
    payload = response.json()
    artifact = payload["artifact"]
    assert artifact["relative_path"].startswith("summary/assets/media-")
    assert f"../assets/{artifact['media_id']}.jpg" in payload["document"]["markdown"]
    assert (tmp_path / "assets" / ASSET_ID / artifact["relative_path"]).is_file()

    connection = sqlite3.connect(tmp_path / "openvideo.sqlite3")
    connection.execute("DELETE FROM summary_media")
    connection.commit()
    connection.close()
    with TestClient(create_app(Settings(library_path=tmp_path))) as reopened:
        assert (
            reopened.get(f"/api/media/assets/{ASSET_ID}/summary-documents").status_code
            == 200
        )
    connection = sqlite3.connect(tmp_path / "openvideo.sqlite3")
    restored_count = connection.execute(
        "SELECT COUNT(*) FROM summary_media"
    ).fetchone()[0]
    connection.close()
    assert restored_count == 1
