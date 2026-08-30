from pathlib import Path

import pytest

from openvideo import analysis_manager as analysis_manager_module
from openvideo.analysis_manager import AnalysisManager
from openvideo.core.analysis_models import (
    AnalysisCapability,
    AnalysisDepth,
    AnalysisOperation,
    AnalysisStage,
)
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import (
    MediaAsset,
    MediaAssetStatus,
    MediaSegment,
    SourcePlatform,
)
from openvideo.core.transcription_models import Transcript, TranscriptSegment
from openvideo.settings import Settings
from openvideo.tools.transcribe import TranscriptionResult


ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"


@pytest.mark.asyncio
async def test_ready_asset_initializes_all_local_evidence_without_online_model(
    tmp_path: Path,
    monkeypatch,
):
    library_path = tmp_path / "library"
    library_path.mkdir()
    library = MediaLibrary.initialize_directory(library_path)
    asset_directory = library.asset_directory(ASSET_ID)
    asset_directory.mkdir(parents=True, exist_ok=True)
    (asset_directory / "playback.mp4").write_bytes(b"video")
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="https://www.bilibili.com/video/BV1xx411c7mD",
            source_platform=SourcePlatform.BILIBILI,
            status=MediaAssetStatus.READY,
            playback_path="playback.mp4",
            duration_seconds=20,
        )
    )
    settings = Settings(
        library_path=library.library_path,
        models_directory=str(tmp_path / "models"),
    )
    installer_calls = []

    def install_model(descriptor, models_root_directory, report_progress):
        installer_calls.append(descriptor.model)
        report_progress(50, 100)
        model_directory = (
            models_root_directory / descriptor.engine.value / descriptor.model
        )
        model_directory.mkdir(parents=True, exist_ok=True)
        (model_directory / "model.bin").write_bytes(b"model")
        report_progress(100, 100)

    monkeypatch.setattr(
        analysis_manager_module,
        "create_transcriber",
        lambda options, models_root_directory, **_kwargs: object(),
    )
    monkeypatch.setattr(
        analysis_manager_module,
        "transcribe_media",
        lambda *args: TranscriptionResult(
            transcript=Transcript(
                asset_id=ASSET_ID,
                segments=[
                    TranscriptSegment(
                        start_seconds=0,
                        end_seconds=20,
                        text="讲解透视投影与消失点",
                    )
                ],
            ),
            output_source="test-local",
        ),
    )
    captured_pipeline = {}

    def build_local_segments(
        transcript,
        media_path,
        asset_id,
        artifacts_directory,
        duration_seconds,
        resolved_settings,
        describer,
        markers,
        strategy,
        progress_callback,
        chapter_model,
        ocr_reader,
    ):
        del (
            transcript,
            media_path,
            artifacts_directory,
            duration_seconds,
            resolved_settings,
            markers,
        )
        captured_pipeline.update(
            describer=describer,
            chapter_model=chapter_model,
            depth=strategy.depth,
            ocr_reader=ocr_reader,
        )
        progress_callback(AnalysisStage.READING_FRAME_TEXT, 90, "正在识别画面文字")
        return [
            MediaSegment(
                segment_id="segment-019c0000000070008000000000000000",
                asset_id=asset_id,
                start_seconds=0,
                end_seconds=20,
                title="透视投影",
                transcript_text="讲解透视投影与消失点",
                key_frame_paths=["frames/chapter.jpg"],
                ocr_text="画面公式与消失点",
            )
        ]

    monkeypatch.setattr(
        analysis_manager_module,
        "build_segments",
        build_local_segments,
    )
    evidence_updates = []
    manager = AnalysisManager(
        library,
        settings,
        model_installer=install_model,
        ocr_reader=lambda frames: "画面文字",
        on_evidence_ready=lambda: evidence_updates.append(True),
    )

    created = manager.initialize_asset(ASSET_ID)
    await manager.close()
    completed = manager.get(created.job_id)
    transcript = library.load_transcript(ASSET_ID)
    segments = library.load_segments(ASSET_ID)

    assert completed is not None
    assert completed.operation == AnalysisOperation.INITIALIZATION
    assert completed.stage == AnalysisStage.COMPLETE
    assert completed.strategy.depth == AnalysisDepth.DEEP
    assert {
        AnalysisCapability.TRANSCRIPT,
        AnalysisCapability.TIMELINE,
        AnalysisCapability.CHAPTERS,
        AnalysisCapability.KEY_FRAMES,
        AnalysisCapability.OCR,
    }.issubset(completed.capabilities)
    assert installer_calls == ["small"]
    assert transcript is not None
    assert segments[0].ocr_text == "画面公式与消失点"
    assert segments[0].key_frame_paths == ["artifacts/frames/chapter.jpg"]
    assert captured_pipeline["describer"] is None
    assert captured_pipeline["chapter_model"] is None
    assert captured_pipeline["depth"] == AnalysisDepth.DEEP
    assert callable(captured_pipeline["ocr_reader"])
    assert len(evidence_updates) == 2
    library.close()


@pytest.mark.asyncio
async def test_initialization_preserves_partial_evidence_when_keyframes_fail(
    tmp_path: Path,
    monkeypatch,
):
    library_path = tmp_path / "library"
    library_path.mkdir()
    library = MediaLibrary.initialize_directory(library_path)
    asset_directory = library.asset_directory(ASSET_ID)
    asset_directory.mkdir(parents=True, exist_ok=True)
    (asset_directory / "playback.mp4").write_bytes(b"video")
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="https://www.bilibili.com/video/BV1xx411c7mD",
            source_platform=SourcePlatform.BILIBILI,
            status=MediaAssetStatus.READY,
            playback_path="playback.mp4",
            duration_seconds=20,
        )
    )
    transcript = Transcript(
        asset_id=ASSET_ID,
        segments=[
            TranscriptSegment(
                start_seconds=0,
                end_seconds=20,
                text="讲解透视投影与消失点",
            )
        ],
    )
    library.save_transcript(transcript)
    monkeypatch.setattr(
        analysis_manager_module,
        "build_segments",
        lambda *args: [
            MediaSegment(
                segment_id="segment-019c0000000070008000000000000000",
                asset_id=ASSET_ID,
                start_seconds=0,
                end_seconds=20,
                title="透视投影",
                transcript_text="讲解透视投影与消失点",
            )
        ],
    )
    evidence_updates = []
    manager = AnalysisManager(
        library,
        Settings(
            library_path=library.library_path,
            models_directory=str(tmp_path / "models"),
        ),
        on_evidence_ready=lambda: evidence_updates.append(True),
    )

    created = manager.initialize_asset(ASSET_ID)
    await manager.close()
    failed = manager.get(created.job_id)

    assert failed is not None
    assert failed.stage == AnalysisStage.FAILED
    assert failed.error_message == (
        "本地时间轴已保存，但未能提取关键帧，请检查 FFmpeg 与媒体文件"
    )
    assert AnalysisCapability.TRANSCRIPT in failed.capabilities
    assert AnalysisCapability.TIMELINE in failed.capabilities
    assert AnalysisCapability.CHAPTERS in failed.capabilities
    assert AnalysisCapability.KEY_FRAMES not in failed.capabilities
    assert library.load_transcript(ASSET_ID) == transcript
    assert len(library.load_segments(ASSET_ID)) == 1
    assert evidence_updates == [True]
    library.close()
