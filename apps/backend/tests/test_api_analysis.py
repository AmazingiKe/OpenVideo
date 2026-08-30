import json
from pathlib import Path
from threading import Event
from time import monotonic, sleep

from fastapi.testclient import TestClient

from openvideo.core.ai_models import (
    IMAGE_INPUT_MODALITY,
    TEXT_INPUT_MODALITY,
    AiModelConfiguration,
    InputModality,
)
from openvideo.core.transcription_models import (
    Transcript,
    TranscriptAudioEvent,
    TranscriptEmotion,
    TranscriptSegment,
)
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import (
    MediaAsset,
    MediaAssetStatus,
    MediaSegment,
    SourcePlatform,
)
from openvideo.settings import Settings
from openvideo.tools.transcribe import TranscriptionProgress, TranscriptionResult
from openvideo.ui.api import create_app

import openvideo.analysis_manager as analysis_manager_module


ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"
CONTENT = bytes(range(100))
MODEL_ID = "model-01890f4c7a2b7cc298c4dc0c0c07398f"


def ai_model(
    input_modalities: list[InputModality] | None = None,
) -> AiModelConfiguration:
    return AiModelConfiguration(
        model_id=MODEL_ID,
        name="测试模型",
        litellm_model="openai/test-model",
        api_key="test-key",
        input_modalities=input_modalities or [TEXT_INPUT_MODALITY],
    )


def create_client(tmp_path: Path) -> TestClient:
    library = MediaLibrary.initialize_directory(tmp_path)
    asset_directory = library.asset_directory(ASSET_ID)
    asset_directory.mkdir(parents=True, exist_ok=True)
    (asset_directory / "playback.mp4").write_bytes(CONTENT)
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="https://www.bilibili.com/video/BV1xx411c7mD",
            source_platform=SourcePlatform.BILIBILI,
            source_video_id="BV1xx411c7mD",
            title="测试视频",
            status=MediaAssetStatus.READY,
            playback_path="playback.mp4",
        )
    )
    library.close()
    return TestClient(
        create_app(
            Settings(
                library_path=tmp_path,
                models_directory=str(tmp_path / "models"),
            )
        )
    )


def test_analyze_returns_404_for_missing_asset(tmp_path: Path):
    with create_client(tmp_path) as client:
        response = client.post(
            "/api/media/assets/01890f4c-7a2b-7cc2-98c4-dc0c0c073990/analyze"
        )
    assert response.status_code == 404


def test_transcript_returns_404_when_missing(tmp_path: Path):
    with create_client(tmp_path) as client:
        response = client.get(f"/api/media/assets/{ASSET_ID}/transcript")
    assert response.status_code == 404


def test_transcript_segment_update_is_persisted(tmp_path: Path):
    with create_client(tmp_path) as client:
        client.app.state.library.save_transcript(
            Transcript(
                asset_id=ASSET_ID,
                language="zh",
                segments=[
                    TranscriptSegment(
                        start_seconds=1,
                        end_seconds=3,
                        text="错误文字",
                        emotion=TranscriptEmotion.HAPPY,
                        audio_events=[TranscriptAudioEvent.LAUGHTER],
                    )
                ],
            )
        )
        response = client.patch(
            f"/api/media/assets/{ASSET_ID}/transcript/segments/0",
            json={"text": "修正后的文字"},
        )
        reloaded = client.get(f"/api/media/assets/{ASSET_ID}/transcript")

    assert response.status_code == 200
    assert response.json()["segments"][0]["text"] == "修正后的文字"
    assert response.json()["segments"][0]["emotion"] == "happy"
    assert response.json()["segments"][0]["audio_events"] == ["laughter"]
    assert reloaded.json()["segments"][0]["text"] == "修正后的文字"


def test_transcript_segment_update_rejects_blank_text(tmp_path: Path):
    with create_client(tmp_path) as client:
        client.app.state.library.save_transcript(
            Transcript(
                asset_id=ASSET_ID,
                segments=[
                    TranscriptSegment(start_seconds=1, end_seconds=3, text="原文字")
                ],
            )
        )
        response = client.patch(
            f"/api/media/assets/{ASSET_ID}/transcript/segments/0",
            json={"text": "   "},
        )

    assert response.status_code == 422


def test_ai_model_list_does_not_expose_credentials(tmp_path: Path):
    with create_client(tmp_path) as client:
        client.app.state.settings.ai_models = [
            ai_model([TEXT_INPUT_MODALITY, IMAGE_INPUT_MODALITY])
        ]
        response = client.get("/api/ai/models")

    assert response.status_code == 200
    payload = response.json()[0]
    assert payload["model_id"] == MODEL_ID
    assert payload["name"] == "测试模型"
    assert payload["litellm_model"] == "openai/test-model"
    assert payload["input_modalities"] == ["text", "image"]
    assert payload["capabilities"]["tools"] == "auto"
    assert payload["profile"]["capabilities"]["tools"] == "unknown"
    assert "api_key" not in payload


def test_analyze_creates_job(tmp_path: Path):
    with create_client(tmp_path) as client:
        client.app.state.library.save_transcript(Transcript(asset_id=ASSET_ID))
        response = client.post(f"/api/media/assets/{ASSET_ID}/analyze")

    assert response.status_code == 202
    job = response.json()
    assert job["asset_id"] == ASSET_ID
    assert job["job_id"].startswith("job-")
    assert job["operation"] == "analysis"


def test_analyze_records_selected_image_input_model(tmp_path: Path):
    with create_client(tmp_path) as client:
        client.app.state.settings.ai_models = [
            ai_model([TEXT_INPUT_MODALITY, IMAGE_INPUT_MODALITY])
        ]
        client.app.state.library.save_transcript(Transcript(asset_id=ASSET_ID))
        response = client.post(
            f"/api/media/assets/{ASSET_ID}/analyze",
            json={"ai_model_id": MODEL_ID},
        )

    assert response.status_code == 202
    assert response.json()["ai_model_id"] == MODEL_ID


def test_analyze_rejects_text_only_model_for_visual_task(tmp_path: Path):
    with create_client(tmp_path) as client:
        client.app.state.settings.ai_models = [ai_model()]
        client.app.state.library.save_transcript(Transcript(asset_id=ASSET_ID))
        response = client.post(
            f"/api/media/assets/{ASSET_ID}/analyze",
            json={"ai_model_id": MODEL_ID},
        )

    assert response.status_code == 409
    assert response.json()["detail"] == "所选 AI 模型不支持视觉分析"


def test_legacy_marker_analysis_mode_is_rejected(tmp_path: Path):
    with create_client(tmp_path) as client:
        client.app.state.library.save_transcript(Transcript(asset_id=ASSET_ID))
        marker = client.post(
            f"/api/media/assets/{ASSET_ID}/markers",
            json={
                "start_seconds": 12.5,
                "end_seconds": None,
                "importance": 5,
            },
        ).json()
        response = client.post(
            f"/api/media/assets/{ASSET_ID}/analyze",
            json={
                "mode": "markers",
                "marker_ids": [marker["marker_id"]],
                "force": True,
            },
        )

    assert response.status_code == 422


def test_analysis_requires_transcription(tmp_path: Path):
    with create_client(tmp_path) as client:
        response = client.post(f"/api/media/assets/{ASSET_ID}/analyze")

    assert response.status_code == 409


def test_transcription_creates_independent_job(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(
        analysis_manager_module,
        "transcribe_media",
        lambda *args, **kwargs: TranscriptionResult(
            transcript=Transcript(asset_id=ASSET_ID),
            output_source="faster-whisper",
        ),
    )
    with create_client(tmp_path) as client:
        model_directory = tmp_path / "models" / "faster-whisper" / "small"
        model_directory.mkdir(parents=True)
        (model_directory / "model.bin").write_bytes(b"model")
        response = client.post(f"/api/media/assets/{ASSET_ID}/transcribe")

    assert response.status_code == 202
    assert response.json()["operation"] == "transcription"
    assert response.json()["job_id"].startswith("job-")


def test_transcription_reports_real_audio_progress_and_latest_text(
    tmp_path: Path,
    monkeypatch,
):
    progress_reported = Event()
    finish_transcription = Event()

    def transcribe_with_progress(*args, **_kwargs):
        transcriber = args[-1]
        transcriber.progress_reporter(
            TranscriptionProgress(
                completed_seconds=30,
                total_seconds=60,
                segment_count=3,
                latest_text="这是刚完成的一句字幕",
            )
        )
        progress_reported.set()
        finish_transcription.wait(timeout=5)
        return TranscriptionResult(
            transcript=Transcript(asset_id=ASSET_ID),
            output_source="faster-whisper",
        )

    monkeypatch.setattr(
        analysis_manager_module,
        "transcribe_media",
        transcribe_with_progress,
    )
    with create_client(tmp_path) as client:
        model_directory = tmp_path / "models" / "faster-whisper" / "small"
        model_directory.mkdir(parents=True)
        (model_directory / "model.bin").write_bytes(b"model")
        created = client.post(f"/api/media/assets/{ASSET_ID}/transcribe").json()
        try:
            assert progress_reported.wait(timeout=5)
            running = client.get(f"/api/analysis/{created['job_id']}").json()
            assert running["stage"] == "transcribing"
            assert running["progress_percent"] == 37.5
            assert running["message"] == (
                "已转写 00:30 / 01:00 · 3 段 · 最新：这是刚完成的一句字幕"
            )
        finally:
            finish_transcription.set()


def test_transcription_can_replace_existing_result_multiple_times(
    tmp_path: Path,
    monkeypatch,
):
    generated_texts = iter(("第二版", "第三版"))

    def transcribe_again(*args, **kwargs):
        return TranscriptionResult(
            transcript=Transcript(
                asset_id=ASSET_ID,
                segments=[
                    TranscriptSegment(
                        start_seconds=0,
                        end_seconds=1,
                        text=next(generated_texts),
                    )
                ],
            ),
            output_source="faster-whisper",
        )

    monkeypatch.setattr(analysis_manager_module, "transcribe_media", transcribe_again)
    with create_client(tmp_path) as client:
        model_directory = tmp_path / "models" / "faster-whisper" / "small"
        model_directory.mkdir(parents=True)
        (model_directory / "model.bin").write_bytes(b"model")
        client.app.state.library.save_transcript(
            Transcript(
                asset_id=ASSET_ID,
                segments=[
                    TranscriptSegment(start_seconds=0, end_seconds=1, text="第一版")
                ],
            )
        )

        for expected_text in ("第二版", "第三版"):
            created = client.post(
                f"/api/media/assets/{ASSET_ID}/transcribe",
                json={"force": True},
            ).json()
            job = wait_for_analysis_job(client, created["job_id"])
            assert job["stage"] == "complete"
            assert (
                client.get(f"/api/media/assets/{ASSET_ID}/transcript").json()[
                    "segments"
                ][0]["text"]
                == expected_text
            )

        metadata = client.app.state.library.load_transcription_metadata(ASSET_ID)
        assert metadata is not None
        assert metadata.status == "complete"
        assert metadata.attempt_count == 3
        asset_metadata = json.loads(
            (tmp_path / "assets" / ASSET_ID / "meta.json").read_text(encoding="utf-8")
        )
        assert asset_metadata["transcription"] == {
            "status": "complete",
            "attempt_count": 3,
        }


def test_failed_retranscription_preserves_existing_result(tmp_path: Path, monkeypatch):
    def fail_transcription(*args, **kwargs):
        raise RuntimeError("模型损坏")

    monkeypatch.setattr(analysis_manager_module, "transcribe_media", fail_transcription)
    with create_client(tmp_path) as client:
        model_directory = tmp_path / "models" / "faster-whisper" / "small"
        model_directory.mkdir(parents=True)
        (model_directory / "model.bin").write_bytes(b"model")
        client.app.state.library.save_transcript(
            Transcript(
                asset_id=ASSET_ID,
                segments=[
                    TranscriptSegment(start_seconds=0, end_seconds=1, text="保留版本")
                ],
            )
        )

        created = client.post(
            f"/api/media/assets/{ASSET_ID}/transcribe",
            json={"force": True},
        ).json()
        job = wait_for_analysis_job(client, created["job_id"])

        assert job["stage"] == "failed"
        assert (
            client.get(f"/api/media/assets/{ASSET_ID}/transcript").json()["segments"][
                0
            ]["text"]
            == "保留版本"
        )
        metadata = client.app.state.library.load_transcription_metadata(ASSET_ID)
        assert metadata is not None
        assert metadata.status == "failed"
        assert metadata.attempt_count == 2


def test_transcription_requires_downloaded_model(tmp_path: Path):
    with create_client(tmp_path) as client:
        response = client.post(f"/api/media/assets/{ASSET_ID}/transcribe")

    assert response.status_code == 409
    assert response.json()["detail"] == "Whisper Small 尚未安装，请先下载模型"


def test_transcription_requires_qwen_main_and_companion_models(tmp_path: Path):
    with create_client(tmp_path) as client:
        response = client.post(
            f"/api/media/assets/{ASSET_ID}/transcribe",
            json={
                "engine": "qwen3-asr",
                "model": "qwen3-asr-1.7b",
                "language": "zh",
                "device": "auto",
                "compute_type": "auto",
            },
        )

    assert response.status_code == 409
    assert response.json()["detail"] == "Qwen3-ASR 1.7B 尚未安装，请先下载模型"


def test_segments_returns_empty_when_missing(tmp_path: Path):
    with create_client(tmp_path) as client:
        response = client.get(f"/api/media/assets/{ASSET_ID}/segments")
    assert response.status_code == 200
    assert response.json() == []


def test_segments_and_frame_roundtrip(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    asset_directory = library.asset_directory(ASSET_ID)
    asset_directory.mkdir(parents=True, exist_ok=True)
    (asset_directory / "playback.mp4").write_bytes(CONTENT)
    frames_directory = asset_directory / "artifacts" / "frames"
    frames_directory.mkdir(parents=True, exist_ok=True)
    (frames_directory / "frame.jpg").write_bytes(b"jpeg-bytes")
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="https://www.bilibili.com/video/BV1xx411c7mD",
            source_platform=SourcePlatform.BILIBILI,
            source_video_id="BV1xx411c7mD",
            title="测试视频",
            status=MediaAssetStatus.READY,
            playback_path="playback.mp4",
        )
    )
    library.save_segments(
        ASSET_ID,
        [
            MediaSegment(
                segment_id="segment-0123456789abcdef0123456789abcdef",
                asset_id=ASSET_ID,
                start_seconds=0,
                end_seconds=30,
                transcript_text="重点内容",
                key_frame_paths=["artifacts/frames/frame.jpg"],
                visual_description="画面描述",
            )
        ],
    )
    library.close()
    app = create_app(Settings(library_path=tmp_path))

    with TestClient(app) as client:
        segments_response = client.get(f"/api/media/assets/{ASSET_ID}/segments")
        frame_response = client.get(
            f"/api/media/assets/{ASSET_ID}/frames/artifacts/frames/frame.jpg"
        )

    assert segments_response.status_code == 200
    segments = segments_response.json()
    assert len(segments) == 1
    assert segments[0]["visual_description"] == "画面描述"
    assert frame_response.status_code == 200
    assert frame_response.content == b"jpeg-bytes"


def wait_for_analysis_job(client: TestClient, job_id: str) -> dict[str, object]:
    deadline = monotonic() + 3
    while monotonic() < deadline:
        job = client.get(f"/api/analysis/{job_id}").json()
        if job["stage"] in {"complete", "failed"}:
            return job
        sleep(0.01)
    raise AssertionError("分析任务未在测试时限内结束")
