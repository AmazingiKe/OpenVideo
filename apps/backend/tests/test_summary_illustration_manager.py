import json
import re
import time
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from openvideo.core.agent_evidence_index import IndexedEvidenceDocument
from openvideo.core.agent_evidence_models import AgentEvidenceSource
from openvideo.core.agent_governance_models import AgentPreferences
from openvideo.core.ai_models import IMAGE_INPUT_MODALITY, TEXT_INPUT_MODALITY
from openvideo.core.summary_models import (
    SummaryIllustrationJob,
    SummaryIllustrationSlot,
    SummaryIllustrationStage,
)
from openvideo.tools.frame_quality import QualifiedFrame
from test_api_summary import (
    ASSET_ID,
    MODEL_ID,
    create_client,
    install_generation_mocks,
)


def test_first_summary_inserts_only_vision_verified_frame(tmp_path: Path, monkeypatch):
    install_generation_mocks(monkeypatch)
    _install_illustration_mocks(monkeypatch, confidence="high")
    with create_client(tmp_path) as client:
        _enable_vision_model(client)
        result = _generate(client)
        job = _wait_for_job(client, result["illustration_job"]["job_id"])
        documents = client.get(
            f"/api/media/assets/{ASSET_ID}/summary-documents",
            params={"version_id": result["version"]["version_id"]},
        ).json()
        media = client.app.state.library.load_summary_media(
            ASSET_ID,
            result["version"]["version_id"],
        )

    assert job["stage"] == "complete"
    assert job["inserted_count"] == 1, json.dumps(job, ensure_ascii=False)
    assert job["skipped_count"] == 0
    assert job["metrics"]["vision_calls"] == 1
    assert job["metrics"]["total_ms"] > 0
    assert "![关键操作界面](assets/media-" in documents[0]["markdown"]
    assert len(media) == 1
    assert media[0].origin == "automatic"
    assert media[0].validation_confidence == "high"
    assert media[0].candidate_times == [5.0, 10.0, 15.0]
    assert media[0].source_types == ["transcript"]


def test_medium_confidence_keeps_text_and_records_skip(tmp_path: Path, monkeypatch):
    install_generation_mocks(monkeypatch)
    _install_illustration_mocks(monkeypatch, confidence="medium")
    with create_client(tmp_path) as client:
        _enable_vision_model(client)
        result = _generate(client)
        job = _wait_for_job(client, result["illustration_job"]["job_id"])
        documents = client.get(
            f"/api/media/assets/{ASSET_ID}/summary-documents",
            params={"version_id": result["version"]["version_id"]},
        ).json()

    assert job["stage"] == "complete"
    assert job["inserted_count"] == 0
    assert job["skipped_count"] == 1
    assert job["slots"][0]["confidence"] == "medium"
    assert "![" not in documents[0]["markdown"]


def test_missing_vision_model_finishes_without_blocking_summary(
    tmp_path: Path, monkeypatch
):
    install_generation_mocks(monkeypatch)
    with create_client(tmp_path) as client:
        result = _generate(client)
        job = _wait_for_job(client, result["illustration_job"]["job_id"])

    assert job["stage"] == "complete"
    assert job["message"] == "未配置可用的视觉模型，已保留纯文本总结"


def test_evidence_retrieval_ignores_overwide_analysis_window(
    tmp_path: Path, monkeypatch
):
    with create_client(tmp_path) as client:
        manager = client.app.state.summary_illustration_manager
        broad = _evidence(
            "broad",
            AgentEvidenceSource.ANALYSIS,
            start_seconds=0,
            end_seconds=900,
            relevance_score=0.99,
        )
        precise = _evidence(
            "precise",
            AgentEvidenceSource.TRANSCRIPT,
            start_seconds=48,
            end_seconds=54,
            relevance_score=0.75,
        )
        monkeypatch.setattr(
            manager.library,
            "search_agent_evidence",
            lambda **_kwargs: [broad, precise],
        )
        monkeypatch.setattr(manager.library, "load_markers", lambda _asset_id: [])

        result = manager._retrieve_evidence(
            SummaryIllustrationJob(
                job_id="summary-illustration-job-test",
                asset_id=ASSET_ID,
                version_id="summary-version-test",
                planning_model_id=MODEL_ID,
            ),
            SummaryIllustrationSlot(
                slot_id="illustration-slot-test",
                document_id="document-test",
                target_excerpt="需要准确定位的课程知识点",
                retrieval_query="课程知识点",
                caption="课程知识点画面",
            ),
        )

    assert result is not None
    assert result.document_id == "precise"


def _enable_vision_model(client: TestClient) -> None:
    settings = client.app.state.summary_manager.settings
    settings.ai_models[0].input_modalities = [
        TEXT_INPUT_MODALITY,
        IMAGE_INPUT_MODALITY,
    ]
    settings.agent = AgentPreferences(vision_model_id=MODEL_ID)


def _generate(client: TestClient) -> dict[str, object]:
    response = client.post(
        f"/api/media/assets/{ASSET_ID}/summary-documents/generate",
        json={
            "ai_model_id": MODEL_ID,
            "preset_id": "knowledge_notes",
            "detail": "standard",
            "output_language": "zh-CN",
        },
    )
    assert response.status_code == 201, response.text
    payload = response.json()
    assert payload["illustration_job"] is not None
    return payload


def _wait_for_job(client: TestClient, job_id: str) -> dict[str, object]:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        response = client.get(f"/api/summary-illustration-jobs/{job_id}")
        assert response.status_code == 200
        job = response.json()
        if job["stage"] in {
            SummaryIllustrationStage.COMPLETE,
            SummaryIllustrationStage.FAILED,
        }:
            return job
        time.sleep(0.02)
    raise AssertionError("配图任务未在测试时限内完成")


def _install_illustration_mocks(monkeypatch, *, confidence: str) -> None:
    def plan(_model, messages, *_args, **_kwargs):
        match = re.search(
            r"<最终文档树>\n(.*?)\n</最终文档树>",
            messages[1]["content"],
        )
        assert match is not None
        documents = json.loads(match.group(1))
        root = documents[0]
        return json.dumps(
            {
                "slots": [
                    {
                        "document_id": root["document_id"],
                        "heading_path": [root["title"]],
                        "target_excerpt": root["markdown"],
                        "retrieval_query": "完整转录",
                        "caption": "关键操作界面",
                    }
                ]
            },
            ensure_ascii=False,
        )

    def extract(
        _media_path,
        time_points,
        output_directory,
        _ffmpeg_path,
        _bin_directory,
    ):
        paths = []
        for index, seconds in enumerate(time_points):
            path = output_directory / f"frame-{index}.jpg"
            _draw_frame(path, index)
            paths.append(path)
        return paths

    def qualify(paths, time_points):
        return [
            QualifiedFrame(path=path, seconds=seconds, quality_score=0.9)
            for path, seconds in zip(paths, time_points, strict=True)
        ]

    async def describe(_self, _paths, _prompt):
        return json.dumps(
            {
                "selected_index": 2 if confidence == "high" else None,
                "confidence": confidence,
                "reason": "画面与操作步骤明确一致"
                if confidence == "high"
                else "主体不够明确",
            },
            ensure_ascii=False,
        )

    def generate_media(_source, output, *_args, **_kwargs):
        output.parent.mkdir(parents=True, exist_ok=True)
        _draw_frame(output, 2)

    monkeypatch.setattr(
        "openvideo.summary_illustration_manager.complete_text",
        plan,
    )
    monkeypatch.setattr(
        "openvideo.summary_illustration_manager.refine_scene_candidates",
        lambda *_args, **_kwargs: [5.0, 10.0, 15.0],
    )
    monkeypatch.setattr(
        "openvideo.summary_illustration_manager.extract_frames",
        extract,
    )
    monkeypatch.setattr(
        "openvideo.summary_illustration_manager.filter_candidate_frames",
        qualify,
    )
    monkeypatch.setattr(
        "openvideo.summary_illustration_manager.LiteLlmVision.describe_async",
        describe,
    )
    monkeypatch.setattr(
        "openvideo.summary_manager.generate_summary_media",
        generate_media,
    )


def _draw_frame(path: Path, offset: int) -> None:
    image = Image.new("RGB", (320, 180), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((12 + offset, 12, 300, 50), fill="navy")
    draw.rectangle((12, 62, 110 + offset, 165), fill="gray")
    draw.rectangle((122 + offset, 62, 300, 165), fill="orange")
    image.save(path)


def _evidence(
    document_id: str,
    source_type: AgentEvidenceSource,
    *,
    start_seconds: float,
    end_seconds: float,
    relevance_score: float,
) -> IndexedEvidenceDocument:
    return IndexedEvidenceDocument(
        document_id=document_id,
        asset_id=ASSET_ID,
        source_type=source_type,
        source_version="source-version",
        source_position=0,
        start_seconds=start_seconds,
        end_seconds=end_seconds,
        title="证据",
        text="证据正文",
        relevance_score=relevance_score,
        match_reasons=(),
    )
