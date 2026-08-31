import json
import re
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.event_analysis_models import (
    EventAnalysis,
    EventAnalysisSourceSummary,
    FocusSelection,
    FocusSelectionEventAnalysisTarget,
    MarkerEventAnalysisTarget,
)
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import (
    MediaAsset,
    MediaAssetStatus,
    MediaMarker,
    SourcePlatform,
)
from openvideo.core.summary_files import markdown_digest
from openvideo.core.summary_models import SummaryDocumentCreate
from openvideo.core.transcription_models import Transcript, TranscriptSegment
from openvideo.llm.model_profile import ModelLimits, ModelProfile
from openvideo.settings import Settings
from openvideo.ui.api import create_app


ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"
MODEL_ID = "model-01890f4c7a2b7cc298c4dc0c0c07398f"
MARKER_ID = "marker-01890f4c7a2b7cc298c4dc0c0c073990"
SELECTION_ID = "focus-selection-01890f4c7a2b7cc298c4dc0c0c073991"


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
            title="总结测试视频",
            duration_seconds=60,
            playback_path="playback.mp4",
            status=MediaAssetStatus.READY,
        )
    )
    library.save_transcript(
        Transcript(
            asset_id=ASSET_ID,
            segments=[
                TranscriptSegment(start_seconds=0, end_seconds=15, text="完整转录甲"),
                TranscriptSegment(start_seconds=15, end_seconds=30, text="完整转录乙"),
            ],
        )
    )
    library.create_marker(
        MediaMarker(
            marker_id=MARKER_ID,
            asset_id=ASSET_ID,
            start_seconds=5,
            end_seconds=20,
            importance=5,
        )
    )
    library.save_focus_selection(
        FocusSelection(
            selection_id=SELECTION_ID,
            asset_id=ASSET_ID,
            in_seconds=10,
            out_seconds=25,
        )
    )
    source = EventAnalysisSourceSummary(
        transcript_digest="t",
        target_digest="m",
        timeline_digest="l",
    )
    library.append_event_analyses(
        ASSET_ID,
        [
            EventAnalysis(
                event_analysis_id="event-analysis-01890f4c7a2b7cc298c4dc0c0c073992",
                asset_id=ASSET_ID,
                target=MarkerEventAnalysisTarget(
                    marker_id=MARKER_ID,
                    start_seconds=5,
                    end_seconds=20,
                ),
                title="正式标记分析",
                conclusion="应进入总结",
                preset_id="course_notes",
                preset_version=1,
                depth="balanced",
                ai_model_id=MODEL_ID,
                source_summary=source,
            ),
            EventAnalysis(
                event_analysis_id="event-analysis-01890f4c7a2b7cc298c4dc0c0c073993",
                asset_id=ASSET_ID,
                target=FocusSelectionEventAnalysisTarget(
                    selection_id=SELECTION_ID,
                    start_seconds=10,
                    end_seconds=25,
                ),
                title="焦点选区分析",
                conclusion="不得进入总结",
                preset_id="course_notes",
                preset_version=1,
                depth="balanced",
                ai_model_id=MODEL_ID,
                source_summary=source,
            ),
        ],
    )
    library.close()
    return TestClient(
        create_app(
            Settings(
                library_path=tmp_path,
                ai_models=[
                    AiModelConfiguration(
                        model_id=MODEL_ID,
                        name="测试模型",
                        litellm_model="openai/test-model",
                    )
                ],
            )
        )
    )


def install_generation_mocks(
    monkeypatch, captured: list[list[dict[str, str]]] | None = None
):
    monkeypatch.setattr(
        "openvideo.summary_manager.CapabilityResolver.resolve",
        lambda *_args, **_kwargs: ModelProfile(
            provider="openai",
            model="test-model",
            limits=ModelLimits(),
        ),
    )
    monkeypatch.setattr(
        "openvideo.summary_manager.litellm.token_counter",
        lambda **_kwargs: 1_000,
    )

    def complete(_model, messages, *_args, **_kwargs):
        if captured is not None:
            captured.append(messages)
        if "规划" in messages[0]["content"]:
            return json.dumps(
                {
                    "documents": [
                        {"key": "root", "title": "课程总结", "parent_key": None},
                        {"key": "chapter", "title": "第一章", "parent_key": "root"},
                    ]
                },
                ensure_ascii=False,
            )
        match = re.search(r"<允许路径表>\n(.*?)\n</允许路径表>", messages[1]["content"])
        assert match is not None
        paths = json.loads(match.group(1))
        return json.dumps(
            {
                "documents": [
                    {
                        "relative_path": item["relative_path"],
                        "markdown": f"# {item['title']}\n\n正文。",
                    }
                    for item in paths
                ]
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr("openvideo.summary_manager.complete_text", complete)


def generate(client: TestClient):
    response = client.post(
        f"/api/media/assets/{ASSET_ID}/summary-documents/generate",
        json={
            "ai_model_id": MODEL_ID,
            "preset_id": "knowledge_notes",
            "user_input": "突出结论",
            "detail": "standard",
            "output_language": "zh-CN",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_summary_presets_and_formal_context_exclude_focus_selection(
    tmp_path: Path,
    monkeypatch,
):
    captured: list[list[dict[str, str]]] = []
    install_generation_mocks(monkeypatch, captured)
    with create_client(tmp_path) as client:
        presets = client.get("/api/summary-presets")
        generated = generate(client)

    assert [item["title"] for item in presets.json()] == [
        "知识笔记",
        "章节整理",
        "复习教练",
        "教程编写",
    ]
    assert generated["version"]["version_id"].startswith("summary-version-")
    assert all(
        "正式标记分析" in messages[1]["content"]
        and "焦点选区分析" not in messages[1]["content"]
        and "不得进入总结" not in messages[1]["content"]
        and '"time_range": "00:05–00:20"' in messages[1]["content"]
        for messages in captured
    )
    assert "不得把秒数解释成分钟" in captured[-1][0]["content"]


def test_generation_appends_versions_and_history_remains_editable(
    tmp_path: Path,
    monkeypatch,
):
    install_generation_mocks(monkeypatch)
    with create_client(tmp_path) as client:
        first = generate(client)
        second = generate(client)
        versions = client.get(f"/api/media/assets/{ASSET_ID}/summary-versions").json()
        first_root = next(
            item for item in first["documents"] if item["parent_document_id"] is None
        )
        updated = client.patch(
            f"/api/summary-documents/{first_root['document_id']}",
            json={"expected_revision": 1, "markdown": "# 历史版本仍可编辑\n"},
        )
        selected = client.patch(
            f"/api/media/assets/{ASSET_ID}/summary-current-version",
            json={"version_id": first["version"]["version_id"]},
        )
        current_documents = client.get(
            f"/api/media/assets/{ASSET_ID}/summary-documents"
        ).json()

    assert len(versions) == 2
    assert first["version"]["version_id"] != second["version"]["version_id"]
    assert updated.status_code == 200
    assert selected.json()["version_id"] == first["version"]["version_id"]
    assert current_documents[0]["version_id"] == first["version"]["version_id"]
    summary_root = tmp_path / "assets" / ASSET_ID / "summary"
    assert (summary_root / "manifest.json").is_file()
    assert len(list((summary_root / "versions").iterdir())) == 2


def test_three_level_document_tree_supports_duplicate_move_and_subtree_delete(
    tmp_path: Path,
    monkeypatch,
):
    install_generation_mocks(monkeypatch)
    with create_client(tmp_path) as client:
        generated = generate(client)
        root = next(
            item
            for item in generated["documents"]
            if item["parent_document_id"] is None
        )
        chapter = next(
            item
            for item in generated["documents"]
            if item["parent_document_id"] == root["document_id"]
        )
        section_response = client.post(
            f"/api/summary-documents/{chapter['document_id']}/children",
            json={"title": "重点公式", "markdown": "$$E=mc^2$$"},
        )
        assert section_response.status_code == 201, section_response.text
        section = section_response.json()

        over_depth = client.post(
            f"/api/summary-documents/{section['document_id']}/children",
            json={"title": "第四级", "markdown": ""},
        )
        duplicate_response = client.post(
            f"/api/summary-documents/{section['document_id']}/duplicate"
        )
        assert duplicate_response.status_code == 201, duplicate_response.text
        duplicate = duplicate_response.json()
        moved_response = client.put(
            f"/api/summary-documents/{duplicate['document_id']}/move",
            json={"parent_document_id": root["document_id"], "position": 0},
        )
        invalid_cycle = client.put(
            f"/api/summary-documents/{chapter['document_id']}/move",
            json={"parent_document_id": section["document_id"], "position": 0},
        )
        deleted = client.delete(f"/api/summary-documents/{chapter['document_id']}")
        remaining = client.get(f"/api/media/assets/{ASSET_ID}/summary-documents").json()

    assert over_depth.status_code == 409
    assert "三级" in over_depth.json()["detail"]
    assert duplicate["markdown"] == section["markdown"]
    assert duplicate["title"] == "重点公式 副本"
    assert moved_response.status_code == 200, moved_response.text
    moved = next(
        item
        for item in moved_response.json()
        if item["document_id"] == duplicate["document_id"]
    )
    assert moved["parent_document_id"] == root["document_id"]
    assert moved["position"] == 0
    assert invalid_cycle.status_code == 422
    assert deleted.status_code == 204
    assert {item["document_id"] for item in remaining} == {
        root["document_id"],
        duplicate["document_id"],
    }


def test_agent_summary_batch_restores_all_files_when_manifest_commit_fails(
    tmp_path: Path,
    monkeypatch,
):
    install_generation_mocks(monkeypatch)
    with create_client(tmp_path) as client:
        generated = generate(client)
        root = next(
            item
            for item in generated["documents"]
            if item["parent_document_id"] is None
        )
        manager = client.app.state.summary_manager

        def fail_manifest_commit(*_args, **_kwargs):
            raise OSError("清单提交失败")

        monkeypatch.setattr(
            "openvideo.summary_manager.write_version_manifest",
            fail_manifest_commit,
        )
        with pytest.raises(OSError, match="清单提交失败"):
            manager.apply_agent_edit(
                root["document_id"],
                root["revision"],
                "# Agent 修改\n",
                [SummaryDocumentCreate(title="新增章节", markdown="正文")],
            )

        restored = manager.library.load_summary_document(root["document_id"])
        documents = manager.documents(ASSET_ID, root["version_id"])

    assert restored is not None
    assert restored.markdown == root["markdown"]
    assert restored.revision == root["revision"]
    assert {item.document_id for item in documents} == {
        item["document_id"] for item in generated["documents"]
    }


def test_generation_rejects_paths_outside_preallocated_whitelist(
    tmp_path: Path,
    monkeypatch,
):
    install_generation_mocks(monkeypatch)
    responses = iter(
        (
            json.dumps(
                {"documents": [{"key": "root", "title": "总结", "parent_key": None}]},
                ensure_ascii=False,
            ),
            json.dumps(
                {"documents": [{"relative_path": "../escape.md", "markdown": "越界"}]},
                ensure_ascii=False,
            ),
            json.dumps(
                {"documents": [{"relative_path": "../escape.md", "markdown": "越界"}]},
                ensure_ascii=False,
            ),
        )
    )
    monkeypatch.setattr(
        "openvideo.summary_manager.complete_text",
        lambda *_args, **_kwargs: next(responses),
    )
    with create_client(tmp_path) as client:
        response = client.post(
            f"/api/media/assets/{ASSET_ID}/summary-documents/generate",
            json={
                "ai_model_id": MODEL_ID,
                "preset_id": "knowledge_notes",
            },
        )

    assert response.status_code == 409
    assert not (tmp_path / "assets" / ASSET_ID / "summary" / "manifest.json").exists()
    assert not (tmp_path / "assets" / ASSET_ID / "summary" / "escape.md").exists()


def test_generation_retries_truncated_body_with_shorter_contract(
    tmp_path: Path,
    monkeypatch,
):
    install_generation_mocks(monkeypatch)
    body_attempts = 0

    def complete(_model, messages, *_args, **_kwargs):
        nonlocal body_attempts
        if "规划" in messages[0]["content"]:
            return json.dumps(
                {"documents": [{"key": "root", "title": "总结", "parent_key": None}]},
                ensure_ascii=False,
            )
        body_attempts += 1
        if body_attempts == 1:
            return '{"documents":[{"relative_path":"index.md","markdown":"未闭合'
        assert "上一轮响应未通过" in messages[1]["content"]
        match = re.search(r"<允许路径表>\n(.*?)\n</允许路径表>", messages[1]["content"])
        assert match is not None
        path = json.loads(match.group(1))[0]["relative_path"]
        return json.dumps(
            {"documents": [{"relative_path": path, "markdown": "# 完整总结\n"}]},
            ensure_ascii=False,
        )

    monkeypatch.setattr("openvideo.summary_manager.complete_text", complete)
    with create_client(tmp_path) as client:
        response = client.post(
            f"/api/media/assets/{ASSET_ID}/summary-documents/generate",
            json={"ai_model_id": MODEL_ID, "preset_id": "knowledge_notes"},
        )

    assert response.status_code == 201, response.text
    assert body_attempts == 2
    assert response.json()["documents"][0]["markdown"] == "# 完整总结\n"


def test_generation_prunes_oversized_plan_for_concise_summary(
    tmp_path: Path,
    monkeypatch,
):
    plan_calls = 0

    def complete(_model, messages, *_args, **_kwargs):
        nonlocal plan_calls
        if "规划" in messages[0]["content"]:
            plan_calls += 1
            return json.dumps(
                {
                    "documents": [
                        {"key": "root", "title": "概览", "parent_key": None},
                        {"key": "first", "title": "核心", "parent_key": "root"},
                        {"key": "second", "title": "补充", "parent_key": "root"},
                    ]
                },
                ensure_ascii=False,
            )
        match = re.search(r"<允许路径表>\n(.*?)\n</允许路径表>", messages[1]["content"])
        assert match is not None
        paths = json.loads(match.group(1))
        return json.dumps(
            {
                "documents": [
                    {"relative_path": item["relative_path"], "markdown": "# 笔记"}
                    for item in paths
                ]
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr("openvideo.summary_manager.complete_text", complete)
    with create_client(tmp_path) as client:
        response = client.post(
            f"/api/media/assets/{ASSET_ID}/summary-documents/generate",
            json={
                "ai_model_id": MODEL_ID,
                "preset_id": "knowledge_notes",
                "detail": "concise",
            },
        )

    assert response.status_code == 201, response.text
    assert plan_calls == 1
    assert [item["title"] for item in response.json()["documents"]] == [
        "概览",
        "核心",
    ]


def test_generation_ignores_unused_document_fields(tmp_path: Path, monkeypatch):
    install_generation_mocks(monkeypatch)

    def complete(_model, messages, *_args, **_kwargs):
        if "规划" in messages[0]["content"]:
            return json.dumps(
                {"documents": [{"key": "root", "title": "总结", "parent_key": None}]},
                ensure_ascii=False,
            )
        assert "不得用常识补全" in messages[0]["content"]
        match = re.search(r"<允许路径表>\n(.*?)\n</允许路径表>", messages[1]["content"])
        assert match is not None
        path = json.loads(match.group(1))[0]["relative_path"]
        return json.dumps(
            {
                "documents": [
                    {
                        "relative_path": path,
                        "markdown": "# 总结",
                        "parent_document_id": None,
                    }
                ]
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr("openvideo.summary_manager.complete_text", complete)
    with create_client(tmp_path) as client:
        response = client.post(
            f"/api/media/assets/{ASSET_ID}/summary-documents/generate",
            json={"ai_model_id": MODEL_ID, "preset_id": "knowledge_notes"},
        )

    assert response.status_code == 201, response.text
    assert response.json()["documents"][0]["markdown"] == "# 总结\n"


def test_generation_sanitizes_unallocated_markdown_links(
    tmp_path: Path,
    monkeypatch,
):
    install_generation_mocks(monkeypatch)

    def complete(_model, messages, *_args, **_kwargs):
        if "规划" in messages[0]["content"]:
            return json.dumps(
                {"documents": [{"key": "root", "title": "总结", "parent_key": None}]},
                ensure_ascii=False,
            )
        match = re.search(r"<允许路径表>\n(.*?)\n</允许路径表>", messages[1]["content"])
        assert match is not None
        path = json.loads(match.group(1))[0]["relative_path"]
        return json.dumps(
            {
                "documents": [
                    {
                        "relative_path": path,
                        "markdown": (
                            "[越界](../outside.md)\n"
                            "[外链](https://example.com)\n"
                            "![坏图](../bad.png)"
                        ),
                    }
                ]
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr("openvideo.summary_manager.complete_text", complete)
    with create_client(tmp_path) as client:
        response = client.post(
            f"/api/media/assets/{ASSET_ID}/summary-documents/generate",
            json={"ai_model_id": MODEL_ID, "preset_id": "knowledge_notes"},
        )

    assert response.status_code == 201, response.text
    assert response.json()["documents"][0]["markdown"] == (
        "越界\n[外链](https://example.com)\n图片：坏图\n"
    )
    assert not (tmp_path / "assets" / ASSET_ID / "summary" / "outside.md").exists()


def test_generation_rejects_evidence_time_beyond_media_duration(
    tmp_path: Path,
    monkeypatch,
):
    responses = iter(
        (
            json.dumps(
                {"documents": [{"key": "root", "title": "总结", "parent_key": None}]},
                ensure_ascii=False,
            ),
            json.dumps(
                {
                    "documents": [
                        {
                            "relative_path": "index.md",
                            "markdown": "转录不清晰（如0:00-20:00区域）",
                        }
                    ]
                },
                ensure_ascii=False,
            ),
            json.dumps(
                {
                    "documents": [
                        {
                            "relative_path": "index.md",
                            "markdown": "转录不清晰（如0:00-20:00区域）",
                        }
                    ]
                },
                ensure_ascii=False,
            ),
        )
    )
    install_generation_mocks(monkeypatch)
    monkeypatch.setattr(
        "openvideo.summary_manager.complete_text",
        lambda *_args, **_kwargs: next(responses),
    )

    with create_client(tmp_path) as client:
        response = client.post(
            f"/api/media/assets/{ASSET_ID}/summary-documents/generate",
            json={"ai_model_id": MODEL_ID, "preset_id": "knowledge_notes"},
        )

    assert response.status_code == 409
    assert "视频时间超出素材范围" in response.json()["detail"]


def test_generation_normalizes_decimal_evidence_ranges(
    tmp_path: Path,
    monkeypatch,
):
    def complete(_model, messages, *_args, **_kwargs):
        if "规划" in messages[0]["content"]:
            return json.dumps(
                {"documents": [{"key": "root", "title": "总结", "parent_key": None}]},
                ensure_ascii=False,
            )
        return json.dumps(
            {
                "documents": [
                    {
                        "relative_path": "index.md",
                        "markdown": "结论来自 \\[5.2-20.9\\]。",
                    }
                ]
            },
            ensure_ascii=False,
        )

    install_generation_mocks(monkeypatch)
    monkeypatch.setattr("openvideo.summary_manager.complete_text", complete)
    with create_client(tmp_path) as client:
        response = client.post(
            f"/api/media/assets/{ASSET_ID}/summary-documents/generate",
            json={"ai_model_id": MODEL_ID, "preset_id": "knowledge_notes"},
        )

    assert response.status_code == 201, response.text
    assert response.json()["documents"][0]["markdown"] == (
        "结论来自 【00:05–00:20】。\n"
    )


def test_legacy_single_summary_migrates_once(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="https://example.com/legacy",
            source_platform=SourcePlatform.YOUTUBE,
            title="旧总结",
            duration_seconds=60,
            status=MediaAssetStatus.READY,
        )
    )
    asset_directory = library.asset_directory(ASSET_ID)
    library.close()
    summary_directory = asset_directory / "summary"
    summary_directory.mkdir(parents=True)
    markdown = "# 旧总结\n"
    (summary_directory / "index.md").write_text(markdown, encoding="utf-8")
    timestamp = "2026-01-01T00:00:00Z"
    legacy_manifest = json.dumps(
        {
            "format_version": 1,
            "asset_id": ASSET_ID,
            "root_document_id": "document-01890f4c7a2b7cc298c4dc0c0c073994",
            "documents": [
                {
                    "document_id": "document-01890f4c7a2b7cc298c4dc0c0c073994",
                    "parent_document_id": None,
                    "title": "旧总结",
                    "position": 0,
                    "revision": 1,
                    "relative_path": "index.md",
                    "content_digest": markdown_digest(markdown),
                    "created_at": timestamp,
                    "updated_at": timestamp,
                }
            ],
            "media": [],
            "updated_at": timestamp,
        },
        ensure_ascii=False,
    )
    root_manifest_path = summary_directory / "manifest.json"
    root_manifest_path.write_text(legacy_manifest, encoding="utf-8")

    migrated = MediaLibrary.open(tmp_path)
    first_version_id = migrated.load_summary_versions(ASSET_ID)[0].version_id
    assert migrated.load_summary_documents(ASSET_ID)[0].markdown == markdown
    migrated.close()
    root_manifest_path.write_text(legacy_manifest, encoding="utf-8")
    reopened = MediaLibrary.open(tmp_path)
    try:
        assert (
            reopened.load_summary_versions(ASSET_ID)[0].version_id == first_version_id
        )
        assert json.loads(root_manifest_path.read_text("utf-8"))["format_version"] == 2
        assert len(list((summary_directory / "versions").iterdir())) == 1
        assert not (summary_directory / "index.md").exists()
    finally:
        reopened.close()


def test_known_context_capacity_error_is_structured(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(
        "openvideo.summary_manager.CapabilityResolver.resolve",
        lambda *_args, **_kwargs: ModelProfile(
            provider="openai",
            model="test-model",
            limits=ModelLimits(context_tokens=4_000, max_output_tokens=2_000),
        ),
    )
    monkeypatch.setattr(
        "openvideo.summary_manager.litellm.token_counter",
        lambda **_kwargs: 3_000,
    )
    with create_client(tmp_path) as client:
        response = client.post(
            f"/api/media/assets/{ASSET_ID}/summary-documents/generate",
            json={"ai_model_id": MODEL_ID, "preset_id": "knowledge_notes"},
        )

    assert response.status_code == 409
    assert response.json()["code"] == "summary_context_capacity_exceeded"
    assert response.json()["stage"] == "planning"


def test_known_output_capacity_error_is_structured(tmp_path: Path, monkeypatch):
    install_generation_mocks(monkeypatch)
    monkeypatch.setattr(
        "openvideo.summary_manager.CapabilityResolver.resolve",
        lambda *_args, **_kwargs: ModelProfile(
            provider="openai",
            model="test-model",
            limits=ModelLimits(context_tokens=50_000, max_output_tokens=4_000),
        ),
    )
    with create_client(tmp_path) as client:
        response = client.post(
            f"/api/media/assets/{ASSET_ID}/summary-documents/generate",
            json={"ai_model_id": MODEL_ID, "preset_id": "knowledge_notes"},
        )

    assert response.status_code == 409
    assert response.json()["code"] == "summary_context_capacity_exceeded"
    assert response.json()["stage"] == "writing"
    assert response.json()["required_tokens"] == 8_000
    assert response.json()["context_tokens"] == 4_000


def test_each_version_exports_independently(tmp_path: Path, monkeypatch):
    install_generation_mocks(monkeypatch)
    with create_client(tmp_path) as client:
        first = generate(client)
        second = generate(client)
        exported = client.post(
            f"/api/media/assets/{ASSET_ID}/summary-exports",
            params={"version_id": first["version"]["version_id"]},
        )

    assert exported.status_code == 201
    payload = exported.json()
    assert payload["version_id"] == first["version"]["version_id"]
    assert payload["version_id"] != second["version"]["version_id"]
    path = tmp_path / "assets" / ASSET_ID / payload["relative_path"]
    with zipfile.ZipFile(path) as archive:
        assert {"index.md", "manifest.json"} <= set(archive.namelist())
