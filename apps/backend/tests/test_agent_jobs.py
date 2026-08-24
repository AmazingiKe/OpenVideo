import time
from pathlib import Path
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

import openvideo.agent_manager as agent_manager_module
from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.transcription_models import Transcript, TranscriptSegment
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import MediaAsset, MediaAssetStatus, SourcePlatform
from openvideo.settings import Settings
from openvideo.tools.transcript_correction import (
    TranscriptCorrectionContextLengthError,
)
from openvideo.ui.api import create_app


ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"
MODEL_ID = "model-01890f4c7a2b7cc298c4dc0c0c07398f"
SECOND_MODEL_ID = "model-01890f4c7a2b7cc298c4dc0c0c073990"


def model(model_id: str = MODEL_ID) -> AiModelConfiguration:
    return AiModelConfiguration(
        model_id=model_id,
        name="测试模型",
        litellm_model="openai/test-model",
        api_key="test-key",
    )


def create_client(tmp_path: Path, models=None) -> TestClient:
    if not (tmp_path / "library.json").exists():
        library = MediaLibrary.initialize_directory(tmp_path)
        library.save(
            MediaAsset(
                asset_id=ASSET_ID,
                source_url="https://www.bilibili.com/video/BV1xx411c7mD",
                source_platform=SourcePlatform.BILIBILI,
                title="测试视频",
                status=MediaAssetStatus.READY,
            )
        )
        library.save_transcript(
            Transcript(
                asset_id=ASSET_ID,
                segments=[
                    TranscriptSegment(start_seconds=0, end_seconds=1, text="前文"),
                    TranscriptSegment(start_seconds=1, end_seconds=2, text="错误文字"),
                ],
            )
        )
        library.close()
    return TestClient(
        create_app(Settings(library_path=tmp_path, ai_models=models or [model()]))
    )


def wait_for_stage(client: TestClient, job_id: str, stages: set[str]) -> dict:
    for _ in range(200):
        job = client.get(f"/api/agent-jobs/{job_id}").json()
        if job["stage"] in stages:
            return job
        time.sleep(0.01)
    raise AssertionError(f"Agent 未进入预期阶段：{stages}")


def test_correction_job_is_persisted_and_only_applies_changed_items(
    tmp_path: Path,
    monkeypatch,
):
    request_count = 0

    def correct(_self, transcript, segment_indices):
        nonlocal request_count
        request_count += 1
        assert [segment.text for segment in transcript.segments] == ["前文", "错误文字"]
        assert segment_indices == [0, 1]
        return {1: "修正文字"}

    monkeypatch.setattr(agent_manager_module.LiteLlmTranscriptCorrector, "correct", correct)
    with create_client(tmp_path) as client:
        response = client.post(
            f"/api/media/assets/{ASSET_ID}/transcript/corrections",
            json={"segment_indices": None, "ai_model_id": MODEL_ID},
        )
        assert response.status_code == 202
        job_id = response.json()["job_id"]
        identifier = UUID(hex=job_id.removeprefix("agent-"))
        assert identifier.version == 7
        completed = wait_for_stage(client, job_id, {"complete"})
        transcript = client.get(f"/api/media/assets/{ASSET_ID}/transcript").json()

    assert request_count == 1
    assert completed["progress_percent"] == 100
    assert [segment["text"] for segment in transcript["segments"]] == [
        "前文",
        "修正文字",
    ]
    assert [segment["start_seconds"] for segment in transcript["segments"]] == [0, 1]
    assert [segment["end_seconds"] for segment in transcript["segments"]] == [1, 2]


@pytest.mark.parametrize(
    ("action", "expected_mode"),
    [
        ("change_model", "automatic"),
        ("chunk", "chunked"),
        ("compress", "compressed"),
        ("cancel", "automatic"),
    ],
)
def test_context_limit_answers_resume_from_checkpoint(
    tmp_path: Path,
    monkeypatch,
    action: str,
    expected_mode: str,
):
    def correct(self, _transcript, _indices):
        if action == "change_model" and self.model.model_id == SECOND_MODEL_ID:
            return {0: "换模型修正"}
        raise TranscriptCorrectionContextLengthError("上下文不足")

    monkeypatch.setattr(agent_manager_module.LiteLlmTranscriptCorrector, "correct", correct)
    monkeypatch.setattr(
        agent_manager_module.LiteLlmTranscriptCorrector,
        "correct_chunked",
        lambda *_: {0: "分块修正"},
    )
    monkeypatch.setattr(
        agent_manager_module.LiteLlmTranscriptCorrector,
        "correct_with_compressed_context",
        lambda *_: {0: "压缩修正"},
    )
    with create_client(tmp_path, [model(), model(SECOND_MODEL_ID)]) as client:
        created = client.post(
            f"/api/media/assets/{ASSET_ID}/transcript/corrections",
            json={"segment_indices": [0], "ai_model_id": MODEL_ID},
        ).json()
        waiting = wait_for_stage(client, created["job_id"], {"waiting_for_input"})
        question_identifier = UUID(
            hex=waiting["question"]["question_id"].removeprefix("question-")
        )
        assert question_identifier.version == 7
        duplicate = client.post(
            f"/api/media/assets/{ASSET_ID}/transcript/corrections",
            json={"segment_indices": [1], "ai_model_id": MODEL_ID},
        ).json()
        assert duplicate["job_id"] == created["job_id"]
        response = client.post(
            f"/api/agent-jobs/{created['job_id']}/responses",
            json={
                "question_id": waiting["question"]["question_id"],
                "action": action,
                "ai_model_id": SECOND_MODEL_ID if action == "change_model" else None,
            },
        )
        assert response.status_code == 202
        final_stage = "cancelled" if action == "cancel" else "complete"
        final_job = wait_for_stage(client, created["job_id"], {final_stage})

    assert final_job["execution_mode"] == expected_mode


def test_waiting_job_survives_restart(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(
        agent_manager_module.LiteLlmTranscriptCorrector,
        "correct",
        lambda *_: (_ for _ in ()).throw(
            TranscriptCorrectionContextLengthError("上下文不足")
        ),
    )
    with create_client(tmp_path) as client:
        created = client.post(
            f"/api/media/assets/{ASSET_ID}/transcript/corrections",
            json={"segment_indices": [0], "ai_model_id": MODEL_ID},
        ).json()
        waiting = wait_for_stage(client, created["job_id"], {"waiting_for_input"})

    monkeypatch.setattr(
        agent_manager_module.LiteLlmTranscriptCorrector,
        "correct_chunked",
        lambda *_: {},
    )
    with create_client(tmp_path) as restarted_client:
        active_jobs = restarted_client.get(
            f"/api/media/assets/{ASSET_ID}/agent-jobs?active=true"
        ).json()
        assert active_jobs[0]["stage"] == "waiting_for_input"
        restarted_client.post(
            f"/api/agent-jobs/{created['job_id']}/responses",
            json={
                "question_id": waiting["question"]["question_id"],
                "action": "chunk",
            },
        )
        wait_for_stage(restarted_client, created["job_id"], {"complete"})


def test_transcript_change_requires_rerun_and_never_overwrites_new_text(
    tmp_path: Path,
    monkeypatch,
):
    call_count = 0
    library_holder: dict[str, MediaLibrary] = {}

    def correct(_self, transcript, _indices):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            library_holder["library"].save_transcript(
                transcript.model_copy(
                    update={
                        "segments": [
                            transcript.segments[0].model_copy(update={"text": "用户最新文字"}),
                            transcript.segments[1],
                        ]
                    }
                )
            )
            return {0: "基于旧版的修正"}
        assert transcript.segments[0].text == "用户最新文字"
        return {0: "基于最新版的修正"}

    monkeypatch.setattr(agent_manager_module.LiteLlmTranscriptCorrector, "correct", correct)
    with create_client(tmp_path) as client:
        library_holder["library"] = client.app.state.library
        created = client.post(
            f"/api/media/assets/{ASSET_ID}/transcript/corrections",
            json={"segment_indices": [0], "ai_model_id": MODEL_ID},
        ).json()
        waiting = wait_for_stage(client, created["job_id"], {"waiting_for_input"})
        current = client.get(f"/api/media/assets/{ASSET_ID}/transcript").json()
        assert current["segments"][0]["text"] == "用户最新文字"
        client.post(
            f"/api/agent-jobs/{created['job_id']}/responses",
            json={
                "question_id": waiting["question"]["question_id"],
                "action": "rerun_latest",
            },
        )
        wait_for_stage(client, created["job_id"], {"complete"})
        final_transcript = client.get(f"/api/media/assets/{ASSET_ID}/transcript").json()

    assert final_transcript["segments"][0]["text"] == "基于最新版的修正"
