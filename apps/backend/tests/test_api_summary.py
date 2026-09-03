import json
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import MediaAsset, MediaAssetStatus, SourcePlatform
from openvideo.core.summary_files import markdown_digest
from openvideo.core.summary_models import SummaryDocumentCreate
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
            title="总结测试视频",
            duration_seconds=60,
            playback_path="playback.mp4",
            status=MediaAssetStatus.READY,
        )
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


def save_metadata(client_sequence: int, *, client_id: str | None = None) -> dict:
    return {
        "operation_id": f"summary-operation-{uuid7().hex}",
        "client_id": client_id or f"summary-client-{uuid7().hex}",
        "client_sequence": client_sequence,
    }


def initialize_documents(client: TestClient) -> tuple[dict, dict]:
    root_response = client.post(f"/api/media/assets/{ASSET_ID}/summary-documents/init")
    assert root_response.status_code == 201, root_response.text
    root = root_response.json()
    child_response = client.post(
        f"/api/summary-documents/{root['document_id']}/children",
        json={"title": "第一章", "markdown": "# 第一章\n\n正文。"},
    )
    assert child_response.status_code == 201, child_response.text
    return root, child_response.json()


def test_initializes_one_blank_markdown_document_idempotently(tmp_path: Path):
    with create_client(tmp_path) as client:
        first = client.post(f"/api/media/assets/{ASSET_ID}/summary-documents/init")
        second = client.post(f"/api/media/assets/{ASSET_ID}/summary-documents/init")
        documents = client.get(f"/api/media/assets/{ASSET_ID}/summary-documents").json()

    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json() == second.json()
    assert first.json()["title"] == "总结测试视频"
    assert first.json()["markdown"] == ""
    assert first.json()["relative_path"] == "index.md"
    assert documents == [first.json()]


def test_removed_summary_generation_routes_are_not_exposed(tmp_path: Path):
    with create_client(tmp_path) as client:
        presets = client.get("/api/summary-presets")
        generation = client.post(
            f"/api/media/assets/{ASSET_ID}/summary-documents/generate",
            json={},
        )
        versions = client.get(f"/api/media/assets/{ASSET_ID}/summary-versions")
        selection = client.patch(
            f"/api/media/assets/{ASSET_ID}/summary-current-version",
            json={"version_id": "removed"},
        )

    assert presets.status_code == 404
    assert generation.status_code == 404
    assert versions.status_code == 404
    assert selection.status_code == 404


def test_summary_save_is_idempotent_and_rejects_old_client_sequences(
    tmp_path: Path,
):
    client_id = f"summary-client-{uuid7().hex}"
    operation_id = f"summary-operation-{uuid7().hex}"
    with create_client(tmp_path) as client:
        root = client.post(
            f"/api/media/assets/{ASSET_ID}/summary-documents/init"
        ).json()
        endpoint = f"/api/summary-documents/{root['document_id']}"
        first = client.patch(
            endpoint,
            json={
                "operation_id": operation_id,
                "client_id": client_id,
                "client_sequence": 1,
                "markdown": "# 第一次保存\n",
            },
        )
        duplicate = client.patch(
            endpoint,
            json={
                "operation_id": operation_id,
                "client_id": client_id,
                "client_sequence": 1,
                "markdown": "# 重复请求不应覆盖\n",
            },
        )
        stale = client.patch(
            endpoint,
            json={
                **save_metadata(1, client_id=client_id),
                "markdown": "# 旧序列不应覆盖\n",
            },
        )
        latest = client.patch(
            endpoint,
            json={
                **save_metadata(2, client_id=client_id),
                "markdown": "# 第二次保存\n",
            },
        )

    assert first.status_code == 200
    assert duplicate.json()["markdown"] == "# 第一次保存\n"
    assert stale.json()["markdown"] == "# 第一次保存\n"
    assert latest.json()["markdown"] == "# 第二次保存\n"


def test_summary_save_updates_only_document_projection(
    tmp_path: Path,
    monkeypatch,
):
    with create_client(tmp_path) as client:
        root = client.post(
            f"/api/media/assets/{ASSET_ID}/summary-documents/init"
        ).json()

        def fail_full_reindex(*_args, **_kwargs):
            raise AssertionError("保存当前笔记不应重建素材索引")

        monkeypatch.setattr(
            "openvideo.summary_manager.synchronize_asset", fail_full_reindex
        )
        response = client.patch(
            f"/api/summary-documents/{root['document_id']}",
            json={
                **save_metadata(1),
                "title": "局部保存",
                "markdown": "# 局部保存\n",
            },
        )
        reloaded = client.get(f"/api/media/assets/{ASSET_ID}/summary-documents").json()

    assert response.status_code == 200, response.text
    assert response.json()["title"] == "局部保存"
    assert response.json()["markdown"] == "# 局部保存\n"
    assert reloaded[0]["title"] == "局部保存"
    assert reloaded[0]["markdown"] == "# 局部保存\n"


def test_three_level_document_tree_supports_duplicate_move_and_subtree_delete(
    tmp_path: Path,
):
    with create_client(tmp_path) as client:
        root, chapter = initialize_documents(client)
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


def test_move_summary_document_updates_only_document_projection(
    tmp_path: Path,
    monkeypatch,
):
    with create_client(tmp_path) as client:
        root, chapter = initialize_documents(client)
        second_chapter_response = client.post(
            f"/api/summary-documents/{root['document_id']}/children",
            json={"title": "第二章", "markdown": "# 第二章\n"},
        )
        assert second_chapter_response.status_code == 201
        second_chapter = second_chapter_response.json()

        def fail_full_reindex(*_args, **_kwargs):
            raise AssertionError("拖拽排序不应重建素材索引")

        monkeypatch.setattr(
            "openvideo.summary_manager.synchronize_asset", fail_full_reindex
        )
        moved_response = client.put(
            f"/api/summary-documents/{second_chapter['document_id']}/move",
            json={"parent_document_id": root["document_id"], "position": 0},
        )

    assert moved_response.status_code == 200, moved_response.text
    moved = next(
        item
        for item in moved_response.json()
        if item["document_id"] == second_chapter["document_id"]
    )
    moved_chapter = next(
        item
        for item in moved_response.json()
        if item["document_id"] == chapter["document_id"]
    )
    assert moved["position"] == 0
    assert moved_chapter["position"] == 1


def test_agent_summary_batch_restores_all_files_when_manifest_commit_fails(
    tmp_path: Path,
    monkeypatch,
):
    with create_client(tmp_path) as client:
        root, chapter = initialize_documents(client)
        manager = client.app.state.summary_manager

        def fail_manifest_commit(*_args, **_kwargs):
            raise OSError("清单提交失败")

        monkeypatch.setattr(
            "openvideo.summary_manager.write_summary_manifest",
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
        documents = manager.documents(ASSET_ID)

    assert restored is not None
    assert restored.markdown == root["markdown"]
    assert restored.revision == root["revision"]
    assert {item.document_id for item in documents} == {
        root["document_id"],
        chapter["document_id"],
    }


def test_legacy_summary_is_not_migrated(tmp_path: Path):
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

    reopened = MediaLibrary.open(tmp_path)
    try:
        assert reopened.load_summary_documents(ASSET_ID) == []
        assert json.loads(root_manifest_path.read_text("utf-8"))["format_version"] == 1
        assert (summary_directory / "index.md").is_file()
    finally:
        reopened.close()


def test_export_reads_the_current_initialized_project(tmp_path: Path):
    with create_client(tmp_path) as client:
        initialize_documents(client)
        project = client.app.state.summary_manager.project(ASSET_ID)
        exported = client.post(f"/api/media/assets/{ASSET_ID}/summary-exports")

    assert project is not None
    assert exported.status_code == 201
    payload = exported.json()
    assert "version_id" not in payload
    path = tmp_path / "assets" / ASSET_ID / payload["relative_path"]
    with zipfile.ZipFile(path) as archive:
        assert {"index.md", "manifest.json"} <= set(archive.namelist())
        export_manifest = json.loads(archive.read("manifest.json"))
        assert export_manifest["project"]["revision"] == project.revision
