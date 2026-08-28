import json
from pathlib import Path
from time import monotonic, sleep

from fastapi.testclient import TestClient

from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.identifiers import is_prefixed_uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import MediaAsset, MediaAssetStatus, SourcePlatform
from openvideo.core.transcription_models import Transcript, TranscriptSegment
from openvideo.settings import Settings
from openvideo.ui.api import create_app


ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"
MODEL_ID = "model-01890f4c7a2b7cc298c4dc0c0c07398f"


def create_client(tmp_path: Path) -> TestClient:
    library = MediaLibrary.initialize_directory(tmp_path)
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="https://example.com/video",
            source_platform=SourcePlatform.YOUTUBE,
            title="事件分析测试",
            duration_seconds=60,
            status=MediaAssetStatus.READY,
        )
    )
    library.save_transcript(
        Transcript(
            asset_id=ASSET_ID,
            segments=[
                TranscriptSegment(start_seconds=0, end_seconds=20, text="第一段证据"),
                TranscriptSegment(start_seconds=20, end_seconds=40, text="第二段证据"),
            ],
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


def wait_for_job(client: TestClient, job_id: str) -> dict[str, object]:
    deadline = monotonic() + 3
    while monotonic() < deadline:
        job = client.get(f"/api/event-analysis-jobs/{job_id}").json()
        if job["stage"] in {"complete", "failed"}:
            return job
        sleep(0.01)
    raise AssertionError("事件分析任务未在测试时限内结束")


def test_focus_selection_persists_endpoints_and_clears_conflict(tmp_path: Path):
    with create_client(tmp_path) as client:
        selected_in = client.patch(
            f"/api/media/assets/{ASSET_ID}/focus-selection",
            json={"in_seconds": 10},
        )
        selected_out = client.patch(
            f"/api/media/assets/{ASSET_ID}/focus-selection",
            json={"out_seconds": 20},
        )
        conflicted = client.patch(
            f"/api/media/assets/{ASSET_ID}/focus-selection",
            json={"in_seconds": 25},
        )
        authoritative_path = (
            tmp_path
            / "assets"
            / ASSET_ID
            / "artifacts"
            / "focus-selection.json"
        )
        assert authoritative_path.is_file()
        restored = client.get(f"/api/media/assets/{ASSET_ID}/focus-selection")
        deleted = client.delete(f"/api/media/assets/{ASSET_ID}/focus-selection")
        missing = client.get(f"/api/media/assets/{ASSET_ID}/focus-selection")

    assert selected_in.status_code == 200
    assert selected_in.json()["out_seconds"] is None
    assert selected_out.json()["revision"] == 2
    assert conflicted.json()["in_seconds"] == 25
    assert conflicted.json()["out_seconds"] is None
    assert conflicted.json()["selection_id"].startswith("focus-selection-")
    assert restored.json() == conflicted.json()
    assert deleted.status_code == 204
    assert missing.status_code == 404
    assert not authoritative_path.exists()


def test_marker_and_focus_jobs_append_structured_results_and_become_stale(
    tmp_path: Path,
    monkeypatch,
):
    output = {
        "title": "局部事件",
        "conclusion": "核心结论",
        "key_points": ["关键点"],
        "evidence": [],
    }
    monkeypatch.setattr(
        "openvideo.event_analysis_manager.complete_text",
        lambda *_args, **_kwargs: json.dumps(output, ensure_ascii=False),
    )
    with create_client(tmp_path) as client:
        marker = client.post(
            f"/api/media/assets/{ASSET_ID}/markers",
            json={"start_seconds": 10, "end_seconds": 20, "importance": 5},
        ).json()
        second_marker = client.post(
            f"/api/media/assets/{ASSET_ID}/markers",
            json={"start_seconds": 25, "end_seconds": 35, "importance": 4},
        ).json()
        created = client.post(
            f"/api/media/assets/{ASSET_ID}/event-analysis-jobs",
            json={
                "marker_ids": [marker["marker_id"], second_marker["marker_id"]],
                "preset_id": "course_notes",
                "depth": "balanced",
                "ai_model_id": MODEL_ID,
            },
        )
        job = wait_for_job(client, created.json()["job_id"])
        analyses = client.get(
            f"/api/media/assets/{ASSET_ID}/event-analyses"
        ).json()
        client.patch(
            f"/api/media/assets/{ASSET_ID}/markers/{marker['marker_id']}",
            json={"end_seconds": 22},
        )
        target_stale = client.get(
            f"/api/media/assets/{ASSET_ID}/event-analyses"
        ).json()
        client.patch(
            f"/api/media/assets/{ASSET_ID}/transcript/segments/1",
            json={"text": "第二段证据已修订"},
        )
        stale = client.get(
            f"/api/media/assets/{ASSET_ID}/event-analyses"
        ).json()
        deleted_analysis_id = next(
            item["event_analysis_id"]
            for item in stale
            if item["target"]["marker_id"] == marker["marker_id"]
        )
        deleted = client.delete(
            f"/api/event-analyses/{deleted_analysis_id}"
        )
        remaining = client.get(
            f"/api/media/assets/{ASSET_ID}/event-analyses"
        ).json()

    assert created.status_code == 202
    assert job["stage"] == "complete"
    assert len(analyses) == 2
    assert set(job["result_ids"]) == {
        item["event_analysis_id"] for item in analyses
    }
    assert all(item["target"]["source"] == "marker" for item in analyses)
    assert "markdown" not in json.dumps(analyses)
    target_statuses = {
        item["target"]["marker_id"]: item["status"] for item in target_stale
    }
    assert target_statuses[marker["marker_id"]] == "stale"
    assert target_statuses[second_marker["marker_id"]] == "valid"
    statuses = {
        item["target"]["marker_id"]: item["status"] for item in stale
    }
    assert statuses[marker["marker_id"]] == "stale"
    assert statuses[second_marker["marker_id"]] == "stale"
    assert deleted.status_code == 204
    assert [item["target"]["marker_id"] for item in remaining] == [
        second_marker["marker_id"]
    ]


def test_focus_job_requires_a_complete_selection(tmp_path: Path):
    with create_client(tmp_path) as client:
        client.patch(
            f"/api/media/assets/{ASSET_ID}/focus-selection",
            json={"in_seconds": 10},
        )
        response = client.post(
            f"/api/media/assets/{ASSET_ID}/event-analysis-jobs",
            json={
                "use_focus_selection": True,
                "preset_id": "course_notes",
                "ai_model_id": MODEL_ID,
            },
        )

    assert response.status_code == 409
    assert response.json()["detail"] == "请先设置完整且有效的 In/Out 焦点选区"


def test_focus_and_event_results_rebuild_from_authoritative_files(
    tmp_path: Path,
    monkeypatch,
):
    output = {
        "title": "重建事件",
        "conclusion": "可从业务文件恢复",
        "key_points": [],
        "evidence": [
            {
                "start_seconds": 10,
                "end_seconds": 12,
                "text": "第一段证据",
                "source": "transcript",
            }
        ],
    }
    monkeypatch.setattr(
        "openvideo.event_analysis_manager.complete_text",
        lambda *_args, **_kwargs: json.dumps(output, ensure_ascii=False),
    )
    with create_client(tmp_path) as client:
        selection = client.patch(
            f"/api/media/assets/{ASSET_ID}/focus-selection",
            json={"in_seconds": 10, "out_seconds": 20},
        ).json()
        created = client.post(
            f"/api/media/assets/{ASSET_ID}/event-analysis-jobs",
            json={
                "use_focus_selection": True,
                "preset_id": "course_notes",
                "ai_model_id": MODEL_ID,
            },
        ).json()
        completed = wait_for_job(client, created["job_id"])

    assert is_prefixed_uuid7(selection["selection_id"], "focus-selection-")
    assert is_prefixed_uuid7(created["job_id"], "event-analysis-job-")
    assert is_prefixed_uuid7(completed["result_ids"][0], "event-analysis-")

    (tmp_path / "openvideo.sqlite3").unlink()
    rebuilt = MediaLibrary.open(tmp_path)
    try:
        assert rebuilt.load_focus_selection(ASSET_ID).selection_id == selection[
            "selection_id"
        ]
        analyses = rebuilt.load_event_analyses(ASSET_ID)
        assert [analysis.event_analysis_id for analysis in analyses] == completed[
            "result_ids"
        ]
    finally:
        rebuilt.close()


def test_event_analysis_rejects_markdown_output(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(
        "openvideo.event_analysis_manager.complete_text",
        lambda *_args, **_kwargs: json.dumps(
            {
                "title": "错误输出",
                "conclusion": "结构中不得包含 Markdown 字段",
                "key_points": [],
                "evidence": [],
                "markdown": "# 不允许",
            },
            ensure_ascii=False,
        ),
    )
    with create_client(tmp_path) as client:
        marker = client.post(
            f"/api/media/assets/{ASSET_ID}/markers",
            json={"start_seconds": 10, "end_seconds": 20, "importance": 5},
        ).json()
        created = client.post(
            f"/api/media/assets/{ASSET_ID}/event-analysis-jobs",
            json={
                "marker_ids": [marker["marker_id"]],
                "preset_id": "course_notes",
                "ai_model_id": MODEL_ID,
            },
        ).json()
        failed = wait_for_job(client, created["job_id"])

    assert failed["stage"] == "failed"
    assert failed["result_ids"] == []
