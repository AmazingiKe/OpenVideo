import json
import sys
import wave
from pathlib import Path
from types import ModuleType, SimpleNamespace

import numpy
import pytest

from openvideo.core.transcription_models import (
    TRANSCRIPTION_MODEL_CATALOG,
    Transcript,
    TranscriptAudioEvent,
    TranscriptEmotion,
    TranscriptSegment,
    TranscriptionEngine,
    TranscriptionMetadata,
    TranscriptionOptions,
)
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import MediaAsset, SourcePlatform
from openvideo.tools.transcribe import (
    AUTOMATIC_COMPUTE_TYPE,
    AutomaticFallbackTranscriber,
    CPU_DEVICE_NAME,
    DEFAULT_WHISPER_COMPUTE_TYPE,
    FasterWhisperTranscriber,
    QWEN_TARGET_CHUNK_SECONDS,
    QwenAudioChunk,
    Qwen3AsrTranscriber,
    SenseVoiceTranscriber,
    TimedText,
    TranscriptionFailure,
    TranscriptionQualityFailure,
    _aggregate_qwen_segments,
    _deduplicate_qwen_items,
    _load_qwen_audio_chunks,
    _parse_json3_subtitles,
    _qwen_chunk_quality,
    _qwen_generation_token_budget,
    _qwen_language_name,
    _qwen_quality_is_acceptable,
    _qwen_result_language_codes,
    _resolve_sensevoice_device,
    _runtime_transcription_failure,
    _sensevoice_transcript,
    _split_qwen_audio_chunk,
    create_transcriber,
    extract_audio,
    resolve_whisper_model_source,
)


TRANSCRIPT_ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"


def _all_frames_are_speech(_samples, _sample_rate, _frame_samples, frame_count):
    return [True] * frame_count


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
            TranscriptSegment(
                start_seconds=0.0,
                end_seconds=2.5,
                text="第一句",
                emotion=TranscriptEmotion.HAPPY,
                audio_events=[TranscriptAudioEvent.SPEECH, TranscriptAudioEvent.BGM],
            ),
            TranscriptSegment(start_seconds=2.5, end_seconds=5.0, text="第二句"),
        ],
    )

    library.save_transcript(transcript)
    recovered = library.load_transcript(TRANSCRIPT_ASSET_ID)
    transcript_path = (
        tmp_path / "assets" / TRANSCRIPT_ASSET_ID / "artifacts" / "transcript.json"
    )

    assert recovered is not None
    assert json.loads(transcript_path.read_text(encoding="utf-8"))["language"] == "zh"
    assert recovered.language == "zh"
    assert [segment.text for segment in recovered.segments] == ["第一句", "第二句"]
    assert recovered.segments[0].emotion == TranscriptEmotion.HAPPY
    assert recovered.segments[0].audio_events == [
        TranscriptAudioEvent.SPEECH,
        TranscriptAudioEvent.BGM,
    ]
    assert recovered.segments[1].emotion is None
    assert recovered.segments[1].audio_events == []
    library.close()


def test_library_load_transcript_returns_none_when_missing(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)

    assert library.load_transcript(TRANSCRIPT_ASSET_ID) is None
    library.close()


def test_transcription_metadata_records_source_duration_and_failure(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    library.save(
        MediaAsset(
            asset_id=TRANSCRIPT_ASSET_ID,
            source_url="https://example.com/video",
            source_platform=SourcePlatform.YOUTUBE,
        )
    )
    library.save_transcription_metadata(
        TranscriptionMetadata(
            job_id="job-0123456789abcdef0123456789abcdef",
            asset_id=TRANSCRIPT_ASSET_ID,
            status="failed",
            attempt_count=3,
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
    assert metadata.attempt_count == 3
    asset_metadata = json.loads(
        (tmp_path / "assets" / TRANSCRIPT_ASSET_ID / "meta.json").read_text(
            encoding="utf-8"
        )
    )
    assert asset_metadata["transcription"] == {
        "status": "failed",
        "attempt_count": 3,
    }
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


def test_catalog_exposes_all_runtime_adapters():
    status_by_model = {
        descriptor.model: descriptor.integration_status
        for descriptor in TRANSCRIPTION_MODEL_CATALOG
    }

    assert status_by_model["large-v3-turbo"] == "available"
    assert status_by_model["qwen3-asr-1.7b"] == "available"
    assert status_by_model["sensevoice-small"] == "available"


def test_factory_creates_qwen_and_sensevoice_adapters(tmp_path: Path):
    qwen = create_transcriber(
        TranscriptionOptions(
            engine=TranscriptionEngine.QWEN3_ASR,
            model="qwen3-asr-1.7b",
            device="cuda",
            compute_type="float16",
        ),
        tmp_path,
    )
    sensevoice = create_transcriber(
        TranscriptionOptions(
            engine=TranscriptionEngine.SENSEVOICE,
            model="sensevoice-small",
            device="auto",
            compute_type="auto",
        ),
        tmp_path,
    )

    assert isinstance(qwen, Qwen3AsrTranscriber)
    assert isinstance(sensevoice, SenseVoiceTranscriber)


def test_automatic_fallback_uses_installed_alternative_without_confirmation(
    tmp_path: Path,
):
    closed: list[str] = []

    class Primary:
        engine = TranscriptionEngine.QWEN3_ASR
        output_source = "qwen3-asr"

        def transcribe(self, *_args):
            raise TranscriptionQualityFailure("字幕不完整")

        def close(self):
            closed.append("primary")

    class Fallback:
        engine = TranscriptionEngine.SENSEVOICE
        output_source = "sensevoice"

        def transcribe(self, _audio_path, asset_id):
            return Transcript(
                asset_id=asset_id,
                language="zh",
                segments=[TranscriptSegment(start_seconds=0, end_seconds=1, text="完整")],
            )

        def close(self):
            closed.append("fallback")

    transcriber = AutomaticFallbackTranscriber(Primary(), Fallback())

    transcript = transcriber.transcribe(tmp_path / "audio.wav", TRANSCRIPT_ASSET_ID)
    transcriber.close()

    assert transcript.segments[0].text == "完整"
    assert transcriber.output_source == "qwen3-asr->sensevoice"
    assert closed == ["primary", "fallback"]


def test_faster_whisper_auto_device_falls_back_to_cpu(tmp_path: Path, monkeypatch):
    class UnavailableCudaModel:
        def transcribe(self, *_args, **_kwargs):
            raise RuntimeError("Library cublas64_12.dll is not found or cannot be loaded")

    cpu_model = SimpleNamespace(
        transcribe=lambda *_args, **_kwargs: (
            [SimpleNamespace(start=0.0, end=1.0, text="你好")],
            SimpleNamespace(language="zh"),
        )
    )
    transcriber = FasterWhisperTranscriber(
        model_size="small",
        model_root_directory=tmp_path,
        language="zh",
        device="auto",
        compute_type=AUTOMATIC_COMPUTE_TYPE,
    )
    models = iter([UnavailableCudaModel(), cpu_model])
    monkeypatch.setattr(transcriber, "_load_model", lambda: next(models))

    transcript = transcriber.transcribe(tmp_path / "audio.wav", TRANSCRIPT_ASSET_ID)

    assert [segment.text for segment in transcript.segments] == ["你好"]
    assert transcriber.device == CPU_DEVICE_NAME
    assert transcriber.compute_type == DEFAULT_WHISPER_COMPUTE_TYPE


def test_faster_whisper_explicit_cuda_reports_runtime_failure(
    tmp_path: Path,
    monkeypatch,
):
    transcriber = FasterWhisperTranscriber(
        model_size="small",
        model_root_directory=tmp_path,
        language="zh",
        device="cuda",
        compute_type="float16",
    )
    monkeypatch.setattr(
        transcriber,
        "_load_model",
        lambda: SimpleNamespace(
            transcribe=lambda *_args, **_kwargs: (_ for _ in ()).throw(
                RuntimeError("CUDA runtime unavailable")
            )
        ),
    )

    with pytest.raises(TranscriptionFailure, match="Faster-Whisper 转录失败"):
        transcriber.transcribe(tmp_path / "audio.wav", TRANSCRIPT_ASSET_ID)


@pytest.mark.parametrize(
    ("code", "name"),
    [("zh", "Chinese"), ("yue", "Cantonese"), ("es", "Spanish")],
)
def test_maps_qwen_alignment_languages(code: str, name: str):
    assert _qwen_language_name(code) == name
    assert _qwen_result_language_codes(name) == [code]


def test_rejects_unsupported_qwen_alignment_language():
    with pytest.raises(TranscriptionFailure, match="仅支持"):
        _qwen_language_name("ar")
    with pytest.raises(TranscriptionFailure, match="Arabic"):
        _qwen_result_language_codes("Arabic")


def test_qwen_audio_uses_overlapping_thirty_second_chunks(tmp_path: Path):
    audio_path = tmp_path / "long.wav"
    with wave.open(str(audio_path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16_000)
        audio.writeframes(b"\0\0" * 16_000 * (QWEN_TARGET_CHUNK_SECONDS + 1))

    chunks = list(_load_qwen_audio_chunks(audio_path))

    assert len(chunks) == 2
    assert chunks[0].end_seconds == pytest.approx(30.5, abs=0.03)
    assert chunks[1].start_seconds == pytest.approx(29.5, abs=0.03)
    assert chunks[0].end_seconds - chunks[1].start_seconds == pytest.approx(1)


def test_qwen_generation_budget_scales_with_chunk_duration():
    assert _qwen_generation_token_budget(5) == 512
    assert _qwen_generation_token_budget(30) == 720
    assert _qwen_generation_token_budget(300) == 4096


def test_qwen_retry_chunks_preserve_absolute_time_and_overlap():
    chunk = QwenAudioChunk(
        samples=numpy.zeros(16_000 * 20),
        sample_rate=16_000,
        start_seconds=100,
        end_seconds=120,
    )

    chunks = _split_qwen_audio_chunk(chunk, target_seconds=10)

    assert len(chunks) == 2
    assert chunks[0].start_seconds == 100
    assert chunks[-1].end_seconds == 120
    assert chunks[0].end_seconds - chunks[1].start_seconds == pytest.approx(1)


def test_qwen_quality_gate_measures_uncovered_speech(monkeypatch):
    monkeypatch.setattr(
        "openvideo.tools.transcribe._qwen_speech_activity_mask",
        _all_frames_are_speech,
    )
    samples = numpy.sin(
        numpy.linspace(0, 400 * numpy.pi, 16_000 * 10, dtype=numpy.float32)
    )
    chunk = QwenAudioChunk(samples, 16_000, 0, 10)

    complete = _qwen_chunk_quality(chunk, [TimedText("完整", 0, 10)])
    short_non_speech_tail = _qwen_chunk_quality(chunk, [TimedText("正文", 0, 9)])
    truncated = _qwen_chunk_quality(chunk, [TimedText("截断", 0, 1)])

    assert _qwen_quality_is_acceptable(complete)
    assert _qwen_quality_is_acceptable(short_non_speech_tail)
    assert not _qwen_quality_is_acceptable(truncated)
    assert truncated.max_uncovered_speech_seconds > 3


def test_qwen_quality_gate_ignores_audio_without_detected_speech(monkeypatch):
    monkeypatch.setattr(
        "openvideo.tools.transcribe._qwen_speech_activity_mask",
        lambda _samples, _sample_rate, _frame_samples, frame_count: (
            [False] * frame_count
        ),
    )
    chunk = QwenAudioChunk(numpy.ones(16_000 * 10), 16_000, 0, 10)

    quality = _qwen_chunk_quality(chunk, [])

    assert quality.speech_seconds == 0
    assert _qwen_quality_is_acceptable(quality)


def test_qwen_retries_incomplete_chunk_with_smaller_chunks(
    tmp_path: Path,
    monkeypatch,
):
    samples = numpy.sin(
        numpy.linspace(0, 800 * numpy.pi, 16_000 * 20, dtype=numpy.float32)
    )
    chunk = QwenAudioChunk(samples, 16_000, 0, 20)
    monkeypatch.setattr(
        "openvideo.tools.transcribe._load_qwen_audio_chunks",
        lambda _: iter([chunk]),
    )
    monkeypatch.setattr(
        "openvideo.tools.transcribe._qwen_speech_activity_mask",
        _all_frames_are_speech,
    )
    durations: list[float] = []

    class RetryModel:
        max_new_tokens = 0

        def transcribe(self, **kwargs):
            audio_samples, sample_rate = kwargs["audio"]
            duration = len(audio_samples) / sample_rate
            durations.append(duration)
            aligned_end = duration if duration <= 11 else 1
            return [
                SimpleNamespace(
                    language="Chinese",
                    text="完整。",
                    time_stamps=SimpleNamespace(
                        items=[
                            SimpleNamespace(
                                text="完整。",
                                start_time=0,
                                end_time=aligned_end,
                            )
                        ]
                    ),
                )
            ]

    transcriber = Qwen3AsrTranscriber(
        "qwen3-asr-0.6b", tmp_path, "zh", "cuda", "float16"
    )
    transcriber._model = RetryModel()

    transcript = transcriber.transcribe(tmp_path / "audio.wav", TRANSCRIPT_ASSET_ID)

    assert len(durations) == 3
    assert durations[0] == 20
    assert transcript.segments[0].start_seconds == 0
    assert transcript.segments[-1].end_seconds == pytest.approx(20)


def test_qwen_rejects_incomplete_minimum_chunk(tmp_path: Path, monkeypatch):
    samples = numpy.sin(
        numpy.linspace(0, 320 * numpy.pi, 16_000 * 8, dtype=numpy.float32)
    )
    monkeypatch.setattr(
        "openvideo.tools.transcribe._load_qwen_audio_chunks",
        lambda _: iter([QwenAudioChunk(samples, 16_000, 0, 8)]),
    )
    monkeypatch.setattr(
        "openvideo.tools.transcribe._qwen_speech_activity_mask",
        _all_frames_are_speech,
    )
    transcriber = Qwen3AsrTranscriber(
        "qwen3-asr-0.6b", tmp_path, "zh", "cuda", "float16"
    )
    transcriber._model = SimpleNamespace(
        max_new_tokens=0,
        transcribe=lambda **_: [],
    )

    with pytest.raises(TranscriptionQualityFailure, match="字幕不完整"):
        transcriber.transcribe(tmp_path / "audio.wav", TRANSCRIPT_ASSET_ID)


def test_qwen_deduplicates_identical_items_from_overlap():
    items = _deduplicate_qwen_items(
        [
            TimedText("边界词", 9.5, 10.2),
            TimedText("边界词", 9.8, 10.4),
            TimedText("下一词", 10.4, 11),
        ]
    )

    assert items == [
        TimedText("边界词", 9.5, 10.4),
        TimedText("下一词", 10.4, 11),
    ]


def test_qwen_transcriber_adds_chunk_offset(tmp_path: Path, monkeypatch):
    audio_path = tmp_path / "audio.wav"
    with wave.open(str(audio_path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16_000)
        audio.writeframes(b"\0\0" * 32_000)
    chunks = [
        QwenAudioChunk(numpy.zeros(16_000), 16_000, 0.0, 1.0),
        QwenAudioChunk(numpy.zeros(16_000), 16_000, 240.0, 241.0),
    ]
    monkeypatch.setattr(
        "openvideo.tools.transcribe._load_qwen_audio_chunks",
        lambda _: iter(chunks),
    )
    received_contexts: list[str] = []

    class FakeModel:
        def transcribe(self, **kwargs):
            received_contexts.append(kwargs["context"])
            return [
                SimpleNamespace(
                    language="Chinese",
                    text="一句。",
                    time_stamps=SimpleNamespace(
                        items=[
                            SimpleNamespace(
                                text="乱码",
                                start_time=0.5,
                                end_time=0.5,
                            ),
                            SimpleNamespace(
                                text="一句。",
                                start_time=0.5,
                                end_time=1.0,
                            )
                        ]
                    ),
                )
            ]

    progress_updates = []
    transcriber = Qwen3AsrTranscriber(
        "qwen3-asr-0.6b",
        tmp_path,
        "zh",
        "cuda",
        "float16",
        progress_reporter=progress_updates.append,
        context="GAMES101 现代计算机图形学",
    )
    transcriber._model = FakeModel()

    transcript = transcriber.transcribe(audio_path, TRANSCRIPT_ASSET_ID)

    assert [segment.start_seconds for segment in transcript.segments] == [0.5, 240.5]
    assert progress_updates[0].completed_seconds == 0
    assert progress_updates[0].total_seconds == 2
    assert progress_updates[-1].completed_seconds == 2
    assert progress_updates[-1].segment_count == 2
    assert progress_updates[-1].latest_text == "一句。"
    assert received_contexts == [
        "GAMES101 现代计算机图形学",
        "GAMES101 现代计算机图形学",
    ]


def test_qwen_aggregates_by_punctuation_and_maximum_duration():
    items = [
        TimedText("第一句。", 0, 2),
        TimedText("较长", 2, 10),
        TimedText("内容", 10, 18),
    ]

    segments = _aggregate_qwen_segments(items, "zh")

    assert [segment.text for segment in segments] == ["第一句。", "较长", "内容"]
    assert all(
        segment.end_seconds - segment.start_seconds <= 15 for segment in segments
    )


def test_qwen_keeps_text_together_across_short_pause():
    items = [
        TimedText("短暂停顿前", 0, 1),
        TimedText("短暂停顿后", 1.5, 2.5),
    ]

    segments = _aggregate_qwen_segments(items, "zh")

    assert [segment.text for segment in segments] == ["短暂停顿前短暂停顿后"]


def test_qwen_splits_text_at_silence_break():
    items = [
        TimedText("明显停顿前", 0, 1),
        TimedText("明显停顿后", 1.8, 2.8),
    ]

    segments = _aggregate_qwen_segments(items, "zh")

    assert [segment.text for segment in segments] == ["明显停顿前", "明显停顿后"]


def test_qwen_rejects_empty_timestamp_result(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(
        "openvideo.tools.transcribe._load_qwen_audio_chunks",
        lambda _: iter(
            [QwenAudioChunk(numpy.zeros(16_000), 16_000, 0.0, 1.0)]
        ),
    )
    transcriber = Qwen3AsrTranscriber(
        "qwen3-asr-0.6b", tmp_path, "zh", "cuda", "float16"
    )
    transcriber._model = SimpleNamespace(
        transcribe=lambda **_: [
            SimpleNamespace(language="Chinese", text="", time_stamps=None)
        ]
    )

    with pytest.raises(TranscriptionFailure, match="没有识别到"):
        transcriber.transcribe(tmp_path / "audio.wav", TRANSCRIPT_ASSET_ID)


def test_parses_sensevoice_sentence_labels_and_timestamps():
    transcript = _sensevoice_transcript(
        [
            {
                "text": "<|zh|><|NEUTRAL|><|Speech|>总文本",
                "sentence_info": [
                    {
                        "start": 1000,
                        "end": 2500,
                        "text": "<|zh|><|HAPPY|><|Speech|><|Laughter|>你好",
                    },
                    {
                        "start": 2500,
                        "end": 4000,
                        "text": "<|yue|><|EVENT_UNK|>世界",
                    },
                ],
            }
        ],
        TRANSCRIPT_ASSET_ID,
    )

    assert transcript.language == "zh,yue"
    assert transcript.segments[0].text == "你好"
    assert transcript.segments[0].emotion == TranscriptEmotion.HAPPY
    assert transcript.segments[0].audio_events == [
        TranscriptAudioEvent.SPEECH,
        TranscriptAudioEvent.LAUGHTER,
    ]
    assert transcript.segments[1].audio_events == [TranscriptAudioEvent.UNKNOWN]


def test_sensevoice_requires_sentence_timestamps():
    with pytest.raises(TranscriptionFailure, match="分段时间戳"):
        _sensevoice_transcript([{"text": "你好"}], TRANSCRIPT_ASSET_ID)


def test_sensevoice_device_resolution_and_oom_translation():
    assert _resolve_sensevoice_device("auto", False) == "cpu"
    assert _resolve_sensevoice_device("auto", True) == "cuda:0"
    with pytest.raises(TranscriptionFailure, match="CUDA"):
        _resolve_sensevoice_device("cuda", False)

    error = _runtime_transcription_failure("Qwen3-ASR", RuntimeError("CUDA out of memory"))
    assert str(error) == "Qwen3-ASR 显存不足，请改用更小的模型"


def test_engine_specific_device_and_precision_validation():
    with pytest.raises(ValueError, match="仅支持 CUDA"):
        TranscriptionOptions(
            engine=TranscriptionEngine.QWEN3_ASR,
            model="qwen3-asr-0.6b",
            device="cpu",
            compute_type="auto",
        )
    with pytest.raises(ValueError, match="不支持 int8"):
        TranscriptionOptions(
            engine=TranscriptionEngine.QWEN3_ASR,
            model="qwen3-asr-0.6b",
            device="cuda",
            compute_type="int8",
        )
    with pytest.raises(ValueError, match="仅支持自动选择"):
        TranscriptionOptions(
            engine=TranscriptionEngine.SENSEVOICE,
            model="sensevoice-small",
            device="cuda",
            compute_type="float16",
        )


@pytest.mark.parametrize(
    ("transcriber", "missing_module", "message"),
    [
        (
            Qwen3AsrTranscriber(
                "qwen3-asr-0.6b",
                Path("models"),
                "zh",
                "cuda",
                "float16",
            ),
            "qwen_asr",
            "缺少 Qwen3-ASR 运行依赖",
        ),
        (
            SenseVoiceTranscriber(
                "sensevoice-small",
                Path("models"),
                "zh",
                "auto",
            ),
            "funasr",
            "缺少 SenseVoice 运行依赖",
        ),
    ],
)
def test_missing_runtime_dependencies_are_reported_in_chinese(
    tmp_path: Path,
    monkeypatch,
    transcriber,
    missing_module: str,
    message: str,
):
    transcriber.models_root_directory = tmp_path
    engine_directory = tmp_path / transcriber.engine.value
    (engine_directory / transcriber.model).mkdir(parents=True)
    companion_name = (
        "forced-aligner-0.6b"
        if transcriber.engine == TranscriptionEngine.QWEN3_ASR
        else "fsmn-vad"
    )
    (engine_directory / companion_name).mkdir()
    monkeypatch.setitem(sys.modules, missing_module, None)

    with pytest.raises(TranscriptionFailure, match=message):
        transcriber._load_model()


def test_qwen_auto_device_fails_when_cuda_is_unavailable(
    tmp_path: Path,
    monkeypatch,
):
    engine_directory = tmp_path / "qwen3-asr"
    (engine_directory / "qwen3-asr-0.6b").mkdir(parents=True)
    (engine_directory / "forced-aligner-0.6b").mkdir()
    torch_module = ModuleType("torch")
    torch_module.cuda = SimpleNamespace(is_available=lambda: False)
    qwen_module = ModuleType("qwen_asr")
    qwen_module.Qwen3ASRModel = object
    monkeypatch.setitem(sys.modules, "torch", torch_module)
    monkeypatch.setitem(sys.modules, "qwen_asr", qwen_module)
    transcriber = Qwen3AsrTranscriber(
        "qwen3-asr-0.6b",
        tmp_path,
        "zh",
        "auto",
        "auto",
    )

    with pytest.raises(TranscriptionFailure, match="需要可用的 NVIDIA CUDA"):
        transcriber._load_model()


def test_transcriber_close_releases_model_and_cuda_cache(tmp_path: Path):
    emptied: list[bool] = []
    torch_module = SimpleNamespace(
        cuda=SimpleNamespace(
            is_available=lambda: True,
            empty_cache=lambda: emptied.append(True),
        )
    )
    transcriber = Qwen3AsrTranscriber(
        "qwen3-asr-0.6b", tmp_path, "zh", "cuda", "float16"
    )
    transcriber._model = object()
    transcriber._torch = torch_module

    transcriber.close()

    assert transcriber._model is None
    assert emptied == [True]
