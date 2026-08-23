import json
from pathlib import Path

import pytest

from openvideo.core.analysis_models import (
    TRANSCRIPTION_MODEL_CATALOG,
    Transcript,
    TranscriptSegment,
    TranscriptionEngine,
    TranscriptionMetadata,
    TranscriptionOptions,
)
from openvideo.core.library import MediaLibrary
from openvideo.core.models import MediaAsset, SourcePlatform
from openvideo.tools.transcribe import (
    TranscriptionFailure,
    _parse_json3_subtitles,
    create_transcriber,
    extract_audio,
    resolve_whisper_model_source,
)


TRANSCRIPT_ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"


def test_parses_json3_subtitles_with_timestamps(tmp_path: Path):
    subtitle_path = tmp_path / "subtitle.zh-Hans.json3"
    subtitle_path.write_text(
        json.dumps(
            {
                "events": [
                    {
                        "tStartMs": 1200,
                        "dDurationMs": 1800,
                        "segs": [{"utf8": "第一句"}, {"utf8": " 内容"}],
                    },
                    {"tStartMs": 5000, "dDurationMs": 1000, "segs": [{"utf8": "第二句"}]},
                ]
            }
        ),
        encoding="utf-8",
    )

    transcript = _parse_json3_subtitles(subtitle_path)

    assert transcript.segments[0].start_seconds == pytest.approx(1.2)
    assert transcript.segments[0].end_seconds == pytest.approx(3.0)
    assert transcript.segments[0].text == "第一句 内容"
    assert transcript.segments[1].text == "第二句"


def test_extract_audio_requires_existing_media(tmp_path: Path):
    with pytest.raises(TranscriptionFailure, match="视频文件不存在"):
        extract_audio(
            tmp_path / "missing.mp4",
            tmp_path / "work",
            configured_ffmpeg_path=None,
        )


def test_transcript_model_serializes_segments():
    transcript = Transcript(asset_id=TRANSCRIPT_ASSET_ID)

    assert transcript.model_dump()["segments"] == []


def test_library_roundtrips_transcript(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    library.save(MediaAsset(asset_id=TRANSCRIPT_ASSET_ID, source_url="https://example.com/video", source_platform=SourcePlatform.YOUTUBE))
    transcript = Transcript(
        asset_id=TRANSCRIPT_ASSET_ID,
        language="zh",
        segments=[
            TranscriptSegment(start_seconds=0.0, end_seconds=2.5, text="第一句"),
            TranscriptSegment(start_seconds=2.5, end_seconds=5.0, text="第二句"),
        ],
    )

    library.save_transcript(transcript)
    recovered = library.load_transcript(TRANSCRIPT_ASSET_ID)

    assert recovered is not None
    assert recovered.language == "zh"
    assert [segment.text for segment in recovered.segments] == ["第一句", "第二句"]
    library.close()


def test_library_load_transcript_returns_none_when_missing(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)

    assert library.load_transcript(TRANSCRIPT_ASSET_ID) is None
    library.close()


def test_transcription_metadata_records_source_duration_and_failure(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    library.save_transcription_metadata(
        TranscriptionMetadata(
            job_id="job-0123456789abcdef0123456789abcdef",
            asset_id=TRANSCRIPT_ASSET_ID,
            status="failed",
            output_source="faster-whisper",
            options=TranscriptionOptions(
                model="small",
                language="zh",
                compute_type="int8",
            ),
            duration_seconds=12.5,
            error_message="模型加载失败",
        )
    )

    metadata = library.load_transcription_metadata(TRANSCRIPT_ASSET_ID)

    assert metadata is not None
    assert metadata.output_source == "faster-whisper"
    assert metadata.duration_seconds == 12.5
    assert metadata.error_message == "模型加载失败"
    library.close()


def test_prefers_downloaded_local_model(tmp_path: Path):
    model_directory = tmp_path / "small"
    model_directory.mkdir()
    (model_directory / "model.bin").write_bytes(b"model")

    source = resolve_whisper_model_source("small", tmp_path)

    assert source == str(model_directory.resolve())


def test_rejects_missing_local_model(tmp_path: Path):
    with pytest.raises(TranscriptionFailure, match="转录模型尚未安装"):
        resolve_whisper_model_source("small", tmp_path)


def test_rejects_unsupported_model_name(tmp_path: Path):
    with pytest.raises(TranscriptionFailure, match="不支持的转录模型"):
        resolve_whisper_model_source("../outside", tmp_path)


def test_catalog_exposes_whisper_and_future_engine_adapters():
    status_by_model = {
        descriptor.model: descriptor.integration_status
        for descriptor in TRANSCRIPTION_MODEL_CATALOG
    }

    assert status_by_model["large-v3-turbo"] == "available"
    assert status_by_model["qwen3-asr-1.7b"] == "adapter_required"
    assert status_by_model["sensevoice-small"] == "adapter_required"


def test_factory_rejects_engine_without_runtime_adapter(tmp_path: Path):
    options = TranscriptionOptions(
        engine=TranscriptionEngine.QWEN3_ASR,
        model="qwen3-asr-1.7b",
    )

    with pytest.raises(TranscriptionFailure, match="运行适配器尚未安装"):
        create_transcriber(options, tmp_path)
