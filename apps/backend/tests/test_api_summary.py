import io
import json
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

from openvideo.core.ai_models import TEXT_INPUT_MODALITY, AiModelConfiguration
from openvideo.core.analysis_models import Transcript, TranscriptSegment
from openvideo.core.library import MediaLibrary
from openvideo.core.models import MediaAsset, MediaAssetStatus, MediaSegment, SourcePlatform
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
        child = next(item for item in documents if item["parent_document_id"] is not None)
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
        "subdocuments": [
            {"title": "第一章", "markdown": "# 第一章\n\n章节内容。\n"}
        ],
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
    response_payload = {
        "proposed_markdown": "# Agent 修改\n",
        "explanation": "精简章节",
        "suggested_subdocuments": [],
        "media_suggestions": [
            {
                "media_type": "image",
                "start_seconds": 2,
                "end_seconds": None,
                "insert_after": "# Agent 修改",
                "caption": "关键画面",
            }
        ],
    }
    monkeypatch.setattr(
        "openvideo.summary_manager.complete_text",
        lambda *args, **kwargs: json.dumps(response_payload, ensure_ascii=False),
    )
    with create_client(tmp_path, with_model=True) as client:
        document = generate_documents(client)[0]
        conversation = client.get(
            f"/api/media/assets/{ASSET_ID}/summary-conversation"
        ).json()["conversation"]
        run = client.post(
            f"/api/summary-conversations/{conversation['conversation_id']}/messages",
            json={
                "document_id": document["document_id"],
                "expected_revision": document["revision"],
                "instruction": "精简章节",
                "ai_model_id": MODEL_ID,
                "selection": None,
            },
        )
        events = client.get(
            f"/api/summary-agent-runs/{run.json()['run_id']}/events"
        )
        state = client.get(
            f"/api/media/assets/{ASSET_ID}/summary-conversation"
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
    assert proposal["media_suggestions"][0]["suggestion_id"].startswith("suggestion-")
    assert before_accept["markdown"] != "# Agent 修改\n"
    assert accepted.status_code == 200
    assert after_accept["markdown"] == "# Agent 修改\n"


def test_summary_project_exports_stable_relative_paths(tmp_path: Path):
    with create_client(tmp_path) as client:
        documents = generate_documents(client, children=True)
        root = next(item for item in documents if item["parent_document_id"] is None)
        child = next(item for item in documents if item["parent_document_id"] is not None)
        response = client.get(f"/api/media/assets/{ASSET_ID}/summary-export")

    assert response.status_code == 200
    assert f'filename="{root["document_id"]}.zip"' in response.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = set(archive.namelist())
        assert names == {"index.md", f"docs/{child['document_id']}.md", "manifest.json"}
        assert f"docs/{child['document_id']}.md" in archive.read("index.md").decode()
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["root_document_id"] == root["document_id"]


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
