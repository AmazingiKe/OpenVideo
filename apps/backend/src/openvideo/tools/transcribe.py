"""从视频音轨或平台字幕生成带时间戳文本。

该模块把媒体处理与文字识别隔离：ffmpeg 负责稳定地抽取音频，yt-dlp
负责读取平台已经提供的字幕。没有可用字幕时，调用方可以接入任意
ASR 实现，而不需要改变转写结果的数据结构。
"""

from __future__ import annotations

import gc
import json
import re
import subprocess
import sys
import wave
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from openvideo.core.transcription_models import (
    TRANSCRIPTION_MODEL_CATALOG,
    Transcript,
    TranscriptAudioEvent,
    TranscriptEmotion,
    TranscriptSegment,
    TranscriptionComputeType,
    TranscriptionEngine,
    TranscriptionIntegrationStatus,
    TranscriptionModelDescriptor,
    TranscriptionOptions,
    find_transcription_model,
)
from openvideo.transcription_model_manager import (
    QWEN_FORCED_ALIGNER_DIRECTORY_NAME,
    SENSEVOICE_VAD_DIRECTORY_NAME,
    is_transcription_model_installed,
    transcription_model_directory,
)
from openvideo.tools.media import resolve_tool


AUDIO_SAMPLE_RATE = 16_000
AUDIO_CHANNELS = 1
PCM_SAMPLE_WIDTH_BYTES = 2
PCM16_SCALE = 32_768.0
MILLISECONDS_PER_SECOND = 1_000
COMMAND_TIMEOUT_SECONDS = 300
DEFAULT_WHISPER_MODEL = "small"
DEFAULT_WHISPER_LANGUAGE = "zh"
DEFAULT_WHISPER_COMPUTE_TYPE = "int8"
WHISPER_MODEL_FILE_NAME = "model.bin"
SUPPORTED_WHISPER_MODELS = frozenset(
    descriptor.model
    for descriptor in TRANSCRIPTION_MODEL_CATALOG
    if descriptor.engine == TranscriptionEngine.FASTER_WHISPER
)
AUTOMATIC_COMPUTE_TYPE = "default"
AUTOMATIC_DEVICE = "auto"
CPU_DEVICE_NAME = "cpu"
FASTER_WHISPER_ENGINE_NAME = "Faster-Whisper"
QWEN_TARGET_CHUNK_SECONDS = 30
QWEN_MIN_RETRY_CHUNK_SECONDS = 8
QWEN_CHUNK_CONTEXT_SECONDS = 0.5
QWEN_BOUNDARY_SEARCH_SECONDS = 2
QWEN_ENERGY_WINDOW_MILLISECONDS = 20
QWEN_MAX_RETRY_DEPTH = 2
QWEN_MAX_SEGMENT_SECONDS = 15
# 过滤字词对齐的自然间隔，同时让清晰的口语停顿形成字幕断点。
QWEN_SILENCE_BREAK_SECONDS = 0.8
QWEN_MAX_INFERENCE_BATCH_SIZE = 1
QWEN_MAX_NEW_TOKENS = 4_096
QWEN_MIN_NEW_TOKENS = 512
QWEN_GENERATION_TOKENS_PER_SECOND = 24
QWEN_VAD_THRESHOLD = 0.5
QWEN_VAD_MIN_SPEECH_MILLISECONDS = 160
QWEN_VAD_MIN_SILENCE_MILLISECONDS = 300
QWEN_ALIGNMENT_PADDING_SECONDS = 0.2
QWEN_MIN_QUALITY_SPEECH_SECONDS = 0.5
# 运行时质量门只拦截灾难性缺失，精确率另由完整评测集验收。
QWEN_MIN_SPEECH_COVERAGE = 0.85
QWEN_MAX_UNCOVERED_SPEECH_SECONDS = 3
QWEN_SENTENCE_ENDINGS = frozenset("。！？!?；;.")
QWEN_LANGUAGE_NAMES = {
    "zh": "Chinese",
    "yue": "Cantonese",
    "en": "English",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "ja": "Japanese",
    "ko": "Korean",
    "pt": "Portuguese",
    "ru": "Russian",
    "es": "Spanish",
}
QWEN_LANGUAGE_CODES = {name: code for code, name in QWEN_LANGUAGE_NAMES.items()}
NO_SPACE_ALIGNMENT_LANGUAGES = frozenset({"zh", "yue", "ja", "ko"})
SENSEVOICE_VAD_MAX_SEGMENT_MILLISECONDS = 30_000
SENSEVOICE_MERGE_LENGTH_SECONDS = 15
SENSEVOICE_BATCH_SIZE_SECONDS = 60
AUTOMATIC_LANGUAGE = "auto"
CUDA_DEVICE_NAME = "cuda:0"
HUGGING_FACE_HUB_NAME = "hf"
OUT_OF_MEMORY_ERROR_TEXT = "out of memory"
SENSEVOICE_LANGUAGE_CODES = frozenset({"zh", "yue", "en", "ja", "ko"})
SENSEVOICE_LANGUAGE_TAG = re.compile(r"<\|([^|]+)\|>")
SENSEVOICE_SENTENCE_INFO_FIELD = "sentence_info"
SENSEVOICE_TEXT_FIELD = "text"
SENSEVOICE_SENTENCE_FIELD = "sentence"
SENSEVOICE_START_FIELD = "start"
SENSEVOICE_END_FIELD = "end"
SENSEVOICE_EMOTION_TAGS = {
    "HAPPY": TranscriptEmotion.HAPPY,
    "SAD": TranscriptEmotion.SAD,
    "ANGRY": TranscriptEmotion.ANGRY,
    "NEUTRAL": TranscriptEmotion.NEUTRAL,
    "FEARFUL": TranscriptEmotion.FEARFUL,
    "DISGUSTED": TranscriptEmotion.DISGUSTED,
    "SURPRISED": TranscriptEmotion.SURPRISED,
    "EMO_UNK": TranscriptEmotion.UNKNOWN,
}
SENSEVOICE_AUDIO_EVENT_TAGS = {
    "BGM": TranscriptAudioEvent.BGM,
    "MUSIC": TranscriptAudioEvent.BGM,
    "SPEECH": TranscriptAudioEvent.SPEECH,
    "APPLAUSE": TranscriptAudioEvent.APPLAUSE,
    "LAUGHTER": TranscriptAudioEvent.LAUGHTER,
    "CRY": TranscriptAudioEvent.CRY,
    "SNEEZE": TranscriptAudioEvent.SNEEZE,
    "BREATH": TranscriptAudioEvent.BREATH,
    "COUGH": TranscriptAudioEvent.COUGH,
    "SINGING": TranscriptAudioEvent.SINGING,
    "SPEECH_NOISE": TranscriptAudioEvent.SPEECH_NOISE,
    "EVENT_UNK": TranscriptAudioEvent.UNKNOWN,
}
SENSEVOICE_CONTROL_TAGS = frozenset({"WITHITN", "WOITN", "NOSPEECH"})


class TranscriptionFailure(RuntimeError):
    """媒体无法产生可用的带时间戳文本时抛出。"""


class TranscriptionQualityFailure(TranscriptionFailure):
    """识别进程完成但语音内容不完整时拒绝静默保存结果。"""


@dataclass(frozen=True)
class AudioExtractionResult:
    audio_path: Path


@dataclass(frozen=True)
class TranscriptionResult:
    transcript: Transcript
    output_source: str


@dataclass(frozen=True)
class TranscriptionProgress:
    """描述已稳定完成的音频范围，供长任务展示真实进度和最新文字。"""

    completed_seconds: float
    total_seconds: float
    segment_count: int
    latest_text: str | None = None


TranscriptionProgressReporter = Callable[[TranscriptionProgress], None]


class Transcriber(Protocol):
    """可插拔的文字识别实现，统一返回领域层 Transcript。"""

    engine: TranscriptionEngine
    output_source: str

    def transcribe(self, audio_path: Path, asset_id: str) -> Transcript:
        ...

    def close(self) -> None:
        ...


@dataclass(frozen=True)
class TimedText:
    text: str
    start_seconds: float
    end_seconds: float


@dataclass(frozen=True)
class QwenAudioChunk:
    """保留原音频绝对时间的 Qwen 推理块，避免重试后时间轴漂移。"""

    samples: object
    sample_rate: int
    start_seconds: float
    end_seconds: float


@dataclass(frozen=True)
class QwenChunkQuality:
    """衡量对齐文本是否覆盖了块内实际存在的语音。"""

    speech_seconds: float
    covered_speech_ratio: float
    max_uncovered_speech_seconds: float


def extract_audio(
    media_path: Path,
    output_directory: Path,
    configured_ffmpeg_path: str | None,
    project_bin_dir: Path | None = None,
) -> AudioExtractionResult:
    """将视频转成 16kHz 单声道 WAV，兼容本地 ASR 的常用输入格式。"""
    if not media_path.is_file():
        raise TranscriptionFailure("视频文件不存在，无法提取音频")
    ffmpeg_path = resolve_tool(configured_ffmpeg_path, "ffmpeg", project_bin_dir)
    if not ffmpeg_path:
        raise TranscriptionFailure("未找到 ffmpeg，无法提取音频")

    output_directory.mkdir(parents=True, exist_ok=True)
    audio_path = output_directory / "audio.wav"
    command = [
        ffmpeg_path,
        "-y",
        "-i",
        str(media_path),
        "-vn",
        "-ac",
        str(AUDIO_CHANNELS),
        "-ar",
        str(AUDIO_SAMPLE_RATE),
        "-c:a",
        "pcm_s16le",
        str(audio_path),
    ]
    result = subprocess.run(
        command,
        capture_output=True,
        check=False,
        text=True,
        timeout=COMMAND_TIMEOUT_SECONDS,
    )
    if result.returncode != 0 or not audio_path.is_file():
        raise TranscriptionFailure(_command_error(result.stderr, "音频提取失败"))
    return AudioExtractionResult(audio_path=audio_path)


def extract_platform_subtitles(
    source_url: str,
    output_directory: Path,
) -> Transcript | None:
    """读取平台字幕并转换为统一 Transcript；没有字幕时返回 None。"""
    output_directory.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--no-playlist",
        "--no-warnings",
        "--skip-download",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        "zh.*,en.*",
        "--sub-format",
        "json3",
        "--output",
        str(output_directory / "subtitle.%(ext)s"),
        source_url,
    ]
    result = subprocess.run(
        command,
        capture_output=True,
        check=False,
        text=True,
        timeout=COMMAND_TIMEOUT_SECONDS,
    )
    subtitle_files = sorted(output_directory.glob("subtitle*.json3"))
    if result.returncode != 0 or not subtitle_files:
        return None
    return _parse_json3_subtitles(subtitle_files[0])


def transcribe_media(
    media_path: Path,
    asset_id: str,
    source_url: str,
    work_directory: Path,
    configured_ffmpeg_path: str | None,
    project_bin_dir: Path | None = None,
    transcriber: Transcriber | None = None,
) -> TranscriptionResult:
    """先复用平台字幕，缺失时提取音频并交给 ASR 实现。"""
    try:
        subtitle_transcript = extract_platform_subtitles(
            source_url,
            work_directory / "subtitles",
        )
        if subtitle_transcript:
            return TranscriptionResult(
                transcript=subtitle_transcript.model_copy(update={"asset_id": asset_id}),
                output_source="platform_subtitles",
            )
        if transcriber is None:
            raise TranscriptionFailure(
                "视频没有可用字幕；请配置本地 ASR 后重试"
            )
        audio = extract_audio(
            media_path,
            work_directory / "audio",
            configured_ffmpeg_path,
            project_bin_dir,
        )
        return TranscriptionResult(
            transcript=transcriber.transcribe(audio.audio_path, asset_id),
            output_source=transcriber.output_source,
        )
    finally:
        if transcriber is not None:
            transcriber.close()


class FasterWhisperTranscriber:
    """基于 faster-whisper 的本地 ASR，按任务配置运行设备与量化精度。"""

    engine = TranscriptionEngine.FASTER_WHISPER
    output_source = engine.value

    def __init__(
        self,
        model_size: str = DEFAULT_WHISPER_MODEL,
        model_root_directory: Path | None = None,
        language: str | None = DEFAULT_WHISPER_LANGUAGE,
        device: str = "cpu",
        compute_type: str = DEFAULT_WHISPER_COMPUTE_TYPE,
        progress_reporter: TranscriptionProgressReporter | None = None,
    ) -> None:
        self.model_size = model_size
        self.model_root_directory = model_root_directory
        self.language = language
        self.device = device
        self.compute_type = compute_type
        self.progress_reporter = progress_reporter
        self._model = None

    def transcribe(self, audio_path: Path, asset_id: str) -> Transcript:
        try:
            return self._transcribe_once(audio_path, asset_id)
        except Exception as error:
            if self.device != AUTOMATIC_DEVICE:
                raise _runtime_transcription_failure(
                    FASTER_WHISPER_ENGINE_NAME,
                    error,
                ) from error
            self._model = None
            _release_cuda_memory()
            self.device = CPU_DEVICE_NAME
            if self.compute_type == AUTOMATIC_COMPUTE_TYPE:
                self.compute_type = DEFAULT_WHISPER_COMPUTE_TYPE
            try:
                return self._transcribe_once(audio_path, asset_id)
            except Exception as fallback_error:
                raise _runtime_transcription_failure(
                    FASTER_WHISPER_ENGINE_NAME,
                    fallback_error,
                ) from fallback_error

    def _transcribe_once(self, audio_path: Path, asset_id: str) -> Transcript:
        """单次推理与自动设备回退分离，确保失败后会重建 CPU 模型。"""
        if self._model is None:
            self._model = self._load_model()
        segments, info = self._model.transcribe(
            str(audio_path),
            language=self.language,
            vad_filter=True,
        )
        total_seconds = (
            float(info.duration) if self.progress_reporter is not None else 0.0
        )
        if self.progress_reporter is not None:
            self.progress_reporter(TranscriptionProgress(0, total_seconds, 0))
        transcript_segments: list[TranscriptSegment] = []
        for segment in segments:
            text = segment.text.strip()
            if not text:
                continue
            transcript_segment = TranscriptSegment(
                start_seconds=segment.start,
                end_seconds=segment.end,
                text=text,
            )
            transcript_segments.append(transcript_segment)
            if self.progress_reporter is not None:
                self.progress_reporter(
                    TranscriptionProgress(
                        completed_seconds=min(segment.end, total_seconds),
                        total_seconds=total_seconds,
                        segment_count=len(transcript_segments),
                        latest_text=transcript_segment.text,
                    )
                )
        return Transcript(
            asset_id=asset_id,
            language=info.language,
            segments=transcript_segments,
        )

    def _load_model(self):
        # 延迟导入，避免未安装 ASR 依赖时阻塞其他功能。
        from faster_whisper import WhisperModel

        model_root_directory = self.model_root_directory
        if model_root_directory:
            model_root_directory.mkdir(parents=True, exist_ok=True)
        model_source = resolve_whisper_model_source(
            self.model_size, model_root_directory
        )
        return WhisperModel(
            model_source,
            device=self.device,
            compute_type=self.compute_type,
            download_root=str(model_root_directory) if model_root_directory else None,
        )

    def close(self) -> None:
        self._model = None
        _release_cuda_memory()


class Qwen3AsrTranscriber:
    """用强制对齐结果构建精确字幕；仅支持其覆盖的 11 种语言。"""

    engine = TranscriptionEngine.QWEN3_ASR
    output_source = engine.value

    def __init__(
        self,
        model: str,
        models_root_directory: Path,
        language: str | None,
        device: str,
        compute_type: str,
        progress_reporter: TranscriptionProgressReporter | None = None,
    ) -> None:
        self.model = model
        self.models_root_directory = models_root_directory
        self.language = _qwen_language_name(language)
        self.device = device
        self.compute_type = compute_type
        self.progress_reporter = progress_reporter
        self._model = None
        self._torch = None

    def transcribe(self, audio_path: Path, asset_id: str) -> Transcript:
        try:
            total_seconds = 0.0
            if self.progress_reporter is not None:
                total_seconds = _wav_duration_seconds(audio_path)
                self.progress_reporter(TranscriptionProgress(0, total_seconds, 0))
            if self._model is None:
                self._model = self._load_model()
            timed_items: list[TimedText] = []
            detected_languages: list[str] = []
            for chunk in _load_qwen_audio_chunks(audio_path):
                chunk_items, language_codes = self._transcribe_chunk_with_retry(
                    chunk,
                    retry_depth=0,
                )
                timed_items.extend(chunk_items)
                detected_languages.extend(language_codes)
                if self.progress_reporter is not None:
                    preview_items = _deduplicate_qwen_items(timed_items)
                    preview_language = _merge_language_codes(detected_languages)
                    preview_segments = _aggregate_qwen_segments(
                        preview_items,
                        preview_language,
                    )
                    self.progress_reporter(
                        TranscriptionProgress(
                            completed_seconds=min(chunk.end_seconds, total_seconds),
                            total_seconds=total_seconds,
                            segment_count=len(preview_segments),
                            latest_text=(
                                preview_segments[-1].text if preview_segments else None
                            ),
                        )
                    )
            timed_items = _deduplicate_qwen_items(timed_items)
            if not timed_items:
                raise TranscriptionFailure("Qwen3-ASR 没有识别到可用的带时间戳文本")
            language = _merge_language_codes(detected_languages)
            return Transcript(
                asset_id=asset_id,
                language=language,
                segments=_aggregate_qwen_segments(timed_items, language),
            )
        except TranscriptionFailure:
            raise
        except ValueError as error:
            raise TranscriptionFailure(
                f"Qwen3-ASR 无法为当前语言生成准确时间戳：{error}"
            ) from error
        except Exception as error:
            raise _runtime_transcription_failure("Qwen3-ASR", error) from error

    def _transcribe_chunk_with_retry(
        self,
        chunk: QwenAudioChunk,
        retry_depth: int,
    ) -> tuple[list[TimedText], list[str]]:
        items, language_codes = self._transcribe_chunk(chunk)
        quality = _qwen_chunk_quality(chunk, items)
        if _qwen_quality_is_acceptable(quality):
            return items, language_codes

        duration_seconds = chunk.end_seconds - chunk.start_seconds
        can_retry = (
            retry_depth < QWEN_MAX_RETRY_DEPTH
            and duration_seconds > QWEN_MIN_RETRY_CHUNK_SECONDS
        )
        if can_retry:
            target_seconds = max(
                duration_seconds / 2,
                QWEN_MIN_RETRY_CHUNK_SECONDS,
            )
            retry_chunks = _split_qwen_audio_chunk(chunk, target_seconds)
            if len(retry_chunks) > 1:
                retried_items: list[TimedText] = []
                retried_languages: list[str] = []
                for retry_chunk in retry_chunks:
                    retry_items, retry_languages = self._transcribe_chunk_with_retry(
                        retry_chunk,
                        retry_depth + 1,
                    )
                    retried_items.extend(retry_items)
                    retried_languages.extend(retry_languages)
                retried_items = _deduplicate_qwen_items(retried_items)
                retried_quality = _qwen_chunk_quality(chunk, retried_items)
                if _qwen_quality_is_acceptable(retried_quality):
                    return retried_items, retried_languages
                quality = retried_quality

        raise TranscriptionQualityFailure(
            "Qwen3-ASR 检测到字幕不完整："
            f"{chunk.start_seconds:.1f}–{chunk.end_seconds:.1f} 秒语音覆盖 "
            f"{quality.covered_speech_ratio:.1%}，最长未覆盖语音 "
            f"{quality.max_uncovered_speech_seconds:.1f} 秒"
        )

    def _transcribe_chunk(
        self,
        chunk: QwenAudioChunk,
    ) -> tuple[list[TimedText], list[str]]:
        duration_seconds = chunk.end_seconds - chunk.start_seconds
        self._model.max_new_tokens = _qwen_generation_token_budget(duration_seconds)
        results = self._model.transcribe(
            audio=(chunk.samples, chunk.sample_rate),
            language=self.language,
            return_time_stamps=True,
        )
        if not results:
            return [], []
        result = results[0]
        if not result.text.strip():
            return [], []
        language_codes = _qwen_result_language_codes(result.language)
        if result.time_stamps is None or not result.time_stamps.items:
            raise TranscriptionFailure("Qwen3-ASR 未返回有效的强制对齐时间戳")
        items: list[TimedText] = []
        for item in result.time_stamps.items:
            text = item.text.strip()
            start_seconds = float(item.start_time) + chunk.start_seconds
            end_seconds = float(item.end_time) + chunk.start_seconds
            if not text or end_seconds <= start_seconds:
                continue
            items.append(
                TimedText(
                    text=text,
                    start_seconds=start_seconds,
                    end_seconds=end_seconds,
                )
            )
        return items, language_codes

    def _load_model(self):
        model_directory = _require_model_directory(
            self.models_root_directory,
            self.engine,
            self.model,
            "Qwen3-ASR",
        )
        aligner_directory = _require_model_directory(
            self.models_root_directory,
            self.engine,
            QWEN_FORCED_ALIGNER_DIRECTORY_NAME,
            "Qwen3 ForcedAligner",
        )
        try:
            import torch
            from qwen_asr import Qwen3ASRModel
        except ModuleNotFoundError as error:
            raise TranscriptionFailure(
                "缺少 Qwen3-ASR 运行依赖，请重新安装 OpenVideo"
            ) from error
        self._torch = torch
        if not torch.cuda.is_available():
            raise TranscriptionFailure("Qwen3-ASR 需要可用的 NVIDIA CUDA 设备")
        dtype = (
            torch.float16
            if self.compute_type == TranscriptionComputeType.FLOAT16.value
            else torch.bfloat16
        )
        model_kwargs = {
            "dtype": dtype,
            "device_map": CUDA_DEVICE_NAME,
            "local_files_only": True,
        }
        return Qwen3ASRModel.from_pretrained(
            str(model_directory),
            forced_aligner=str(aligner_directory),
            forced_aligner_kwargs=model_kwargs,
            max_inference_batch_size=QWEN_MAX_INFERENCE_BATCH_SIZE,
            max_new_tokens=QWEN_MAX_NEW_TOKENS,
            **model_kwargs,
        )

    def close(self) -> None:
        self._model = None
        _release_cuda_memory(self._torch)


class SenseVoiceTranscriber:
    """保留 SenseVoice 的语种、情绪和声音事件，并拒绝无时间轴结果。"""

    engine = TranscriptionEngine.SENSEVOICE
    output_source = engine.value

    def __init__(
        self,
        model: str,
        models_root_directory: Path,
        language: str | None,
        device: str,
        progress_reporter: TranscriptionProgressReporter | None = None,
    ) -> None:
        self.model = model
        self.models_root_directory = models_root_directory
        self.language = language or AUTOMATIC_LANGUAGE
        self.device = device
        self.progress_reporter = progress_reporter
        self._model = None
        self._torch = None

    def transcribe(self, audio_path: Path, asset_id: str) -> Transcript:
        try:
            total_seconds = 0.0
            if self.progress_reporter is not None:
                total_seconds = _wav_duration_seconds(audio_path)
                self.progress_reporter(TranscriptionProgress(0, total_seconds, 0))
            if self._model is None:
                self._model = self._load_model()
            results = self._model.generate(
                input=str(audio_path),
                cache={},
                language=self.language,
                use_itn=True,
                batch_size_s=SENSEVOICE_BATCH_SIZE_SECONDS,
                merge_vad=True,
                merge_length_s=SENSEVOICE_MERGE_LENGTH_SECONDS,
                sentence_timestamp=True,
            )
            transcript = _sensevoice_transcript(results, asset_id)
            if self.progress_reporter is not None:
                self.progress_reporter(
                    TranscriptionProgress(
                        completed_seconds=total_seconds,
                        total_seconds=total_seconds,
                        segment_count=len(transcript.segments),
                        latest_text=(
                            transcript.segments[-1].text
                            if transcript.segments
                            else None
                        ),
                    )
                )
            return transcript
        except TranscriptionFailure:
            raise
        except Exception as error:
            raise _runtime_transcription_failure("SenseVoice", error) from error

    def _load_model(self):
        model_directory = _require_model_directory(
            self.models_root_directory,
            self.engine,
            self.model,
            "SenseVoice",
        )
        vad_directory = _require_model_directory(
            self.models_root_directory,
            self.engine,
            SENSEVOICE_VAD_DIRECTORY_NAME,
            "FSMN-VAD",
        )
        try:
            import torch
            from funasr import AutoModel
        except ModuleNotFoundError as error:
            raise TranscriptionFailure(
                "缺少 SenseVoice 运行依赖，请重新安装 OpenVideo"
            ) from error
        self._torch = torch
        device = _resolve_sensevoice_device(self.device, torch.cuda.is_available())
        return AutoModel(
            model=str(model_directory),
            vad_model=str(vad_directory),
            vad_kwargs={
                "max_single_segment_time": SENSEVOICE_VAD_MAX_SEGMENT_MILLISECONDS
            },
            device=device,
            hub=HUGGING_FACE_HUB_NAME,
            disable_update=True,
            disable_pbar=True,
        )

    def close(self) -> None:
        self._model = None
        _release_cuda_memory(self._torch)


class AutomaticFallbackTranscriber:
    """主模型失败时自动使用已安装备用模型，避免用户逐条批准或重建任务。"""

    def __init__(self, primary: Transcriber, fallback: Transcriber) -> None:
        self.primary = primary
        self.fallback = fallback
        self.engine = primary.engine
        self.output_source = primary.output_source
        self._primary_closed = False

    def transcribe(self, audio_path: Path, asset_id: str) -> Transcript:
        try:
            return self.primary.transcribe(audio_path, asset_id)
        except TranscriptionFailure as primary_error:
            self.primary.close()
            self._primary_closed = True
            try:
                transcript = self.fallback.transcribe(audio_path, asset_id)
            except TranscriptionFailure as fallback_error:
                raise TranscriptionFailure(
                    f"{primary_error}；自动回退 {self.fallback.output_source} 也失败："
                    f"{fallback_error}"
                ) from fallback_error
            self.output_source = (
                f"{self.primary.output_source}->{self.fallback.output_source}"
            )
            return transcript

    def close(self) -> None:
        if not self._primary_closed:
            self.primary.close()
            self._primary_closed = True
        self.fallback.close()


def create_transcriber(
    options: TranscriptionOptions,
    models_root_directory: Path,
    *,
    automatic_fallback: bool = True,
    progress_reporter: TranscriptionProgressReporter | None = None,
) -> Transcriber:
    """根据持久化任务选项路由 ASR；未接入的引擎会返回明确状态。"""
    require_transcription_adapter(options)
    if options.engine == TranscriptionEngine.FASTER_WHISPER:
        compute_type = (
            AUTOMATIC_COMPUTE_TYPE
            if options.compute_type == TranscriptionComputeType.AUTO
            else options.compute_type.value
        )
        return FasterWhisperTranscriber(
            model_size=options.model,
            model_root_directory=models_root_directory / options.engine.value,
            language=options.language,
            device=options.device.value,
            compute_type=compute_type,
            progress_reporter=progress_reporter,
        )
    if options.engine == TranscriptionEngine.QWEN3_ASR:
        primary = Qwen3AsrTranscriber(
            model=options.model,
            models_root_directory=models_root_directory,
            language=options.language,
            device=options.device.value,
            compute_type=options.compute_type.value,
            progress_reporter=progress_reporter,
        )
        fallback = (
            _qwen_fallback_transcriber(
                models_root_directory,
                options.language,
                progress_reporter,
            )
            if automatic_fallback
            else None
        )
        if fallback is None:
            return primary
        return AutomaticFallbackTranscriber(primary, fallback)
    if options.engine == TranscriptionEngine.SENSEVOICE:
        return SenseVoiceTranscriber(
            model=options.model,
            models_root_directory=models_root_directory,
            language=options.language,
            device=options.device.value,
            progress_reporter=progress_reporter,
        )
    raise TranscriptionFailure(f"不支持的转录引擎：{options.engine.value}")


def _qwen_fallback_transcriber(
    models_root_directory: Path,
    language: str | None,
    progress_reporter: TranscriptionProgressReporter | None,
) -> Transcriber | None:
    sensevoice_descriptor = find_transcription_model(
        TranscriptionEngine.SENSEVOICE,
        "sensevoice-small",
    )
    sensevoice_supports_language = (
        language is None
        or language == AUTOMATIC_LANGUAGE
        or language in SENSEVOICE_LANGUAGE_CODES
    )
    if (
        sensevoice_descriptor is not None
        and sensevoice_supports_language
        and is_transcription_model_installed(
            sensevoice_descriptor,
            models_root_directory,
        )
    ):
        return SenseVoiceTranscriber(
            model=sensevoice_descriptor.model,
            models_root_directory=models_root_directory,
            language=language,
            device=AUTOMATIC_DEVICE,
            progress_reporter=progress_reporter,
        )

    whisper_descriptor = find_transcription_model(
        TranscriptionEngine.FASTER_WHISPER,
        "large-v3-turbo",
    )
    if whisper_descriptor is not None and is_transcription_model_installed(
        whisper_descriptor,
        models_root_directory,
    ):
        return FasterWhisperTranscriber(
            model_size=whisper_descriptor.model,
            model_root_directory=(
                models_root_directory / TranscriptionEngine.FASTER_WHISPER.value
            ),
            language=language,
            device=AUTOMATIC_DEVICE,
            compute_type=AUTOMATIC_COMPUTE_TYPE,
            progress_reporter=progress_reporter,
        )
    return None


def require_transcription_adapter(
    options: TranscriptionOptions,
) -> TranscriptionModelDescriptor:
    """在创建任务前确认所选模型已有可执行适配器。"""
    descriptor = find_transcription_model(options.engine, options.model)
    if descriptor is None:
        raise TranscriptionFailure("转录模型与引擎不匹配")
    if descriptor.integration_status != TranscriptionIntegrationStatus.AVAILABLE:
        raise TranscriptionFailure(
            f"{descriptor.name} 的运行适配器尚未安装，请先在转录模型设置中完成接入"
        )
    return descriptor


def resolve_whisper_model_source(
    model_size: str, model_root_directory: Path | None
) -> str:
    """手动下载的 CTranslate2 模型优先于同名在线模型，保证离线转换可用。"""
    if model_size not in SUPPORTED_WHISPER_MODELS:
        raise TranscriptionFailure(f"不支持的转录模型：{model_size}")
    if model_root_directory is None:
        return model_size
    local_model_directory = (model_root_directory / model_size).resolve()
    if not local_model_directory.is_relative_to(model_root_directory.resolve()):
        raise TranscriptionFailure("转录模型目录无效")
    if (local_model_directory / WHISPER_MODEL_FILE_NAME).is_file():
        return str(local_model_directory)
    raise TranscriptionFailure(f"转录模型尚未安装：{model_size}")


def _qwen_language_name(language: str | None) -> str | None:
    if language is None or language == AUTOMATIC_LANGUAGE:
        return None
    language_name = QWEN_LANGUAGE_NAMES.get(language)
    if language_name is None:
        supported_codes = "/".join(QWEN_LANGUAGE_NAMES)
        raise TranscriptionFailure(
            f"Qwen ForcedAligner 不支持语言 {language}，仅支持 {supported_codes}"
        )
    return language_name


def _qwen_result_language_codes(language: str) -> list[str]:
    language_names = [part.strip() for part in language.split(",") if part.strip()]
    if not language_names:
        raise TranscriptionFailure("Qwen3-ASR 未识别出可用于强制对齐的语言")
    unsupported = [name for name in language_names if name not in QWEN_LANGUAGE_CODES]
    if unsupported:
        raise TranscriptionFailure(
            "Qwen ForcedAligner 不支持自动识别到的语言："
            + "、".join(unsupported)
        )
    return [QWEN_LANGUAGE_CODES[name] for name in language_names]


def _merge_language_codes(language_codes: list[str]) -> str:
    return ",".join(dict.fromkeys(language_codes))


def _wav_duration_seconds(audio_path: Path) -> float:
    try:
        with wave.open(str(audio_path), "rb") as audio:
            sample_rate = audio.getframerate()
            if sample_rate <= 0:
                raise TranscriptionFailure("提取后的 WAV 音频采样率无效")
            return audio.getnframes() / sample_rate
    except (OSError, wave.Error) as error:
        raise TranscriptionFailure("无法读取提取后的 WAV 音频时长") from error


def _load_qwen_audio_chunks(audio_path: Path):
    try:
        import numpy
    except ModuleNotFoundError as error:
        raise TranscriptionFailure(
            "缺少 Qwen3-ASR 音频处理依赖，请重新安装 OpenVideo"
        ) from error
    try:
        with wave.open(str(audio_path), "rb") as audio:
            sample_rate = audio.getframerate()
            if (
                audio.getnchannels() != AUDIO_CHANNELS
                or audio.getsampwidth() != PCM_SAMPLE_WIDTH_BYTES
                or sample_rate != AUDIO_SAMPLE_RATE
            ):
                raise TranscriptionFailure("Qwen3-ASR 输入必须是 16kHz 单声道 PCM WAV")
            total_frames = audio.getnframes()
            target_frames = round(QWEN_TARGET_CHUNK_SECONDS * sample_rate)
            search_frames = round(QWEN_BOUNDARY_SEARCH_SECONDS * sample_rate)
            base_ranges: list[tuple[int, int]] = []
            range_start = 0
            while total_frames - range_start > target_frames:
                audio.setpos(range_start)
                search_bytes = audio.readframes(target_frames + search_frames)
                search_samples = numpy.frombuffer(search_bytes, dtype="<i2").astype(
                    numpy.float32
                )
                search_samples /= PCM16_SCALE
                relative_boundary = _qwen_low_energy_ranges(
                    search_samples,
                    sample_rate,
                    QWEN_TARGET_CHUNK_SECONDS,
                )[0][1]
                boundary = range_start + relative_boundary
                base_ranges.append((range_start, boundary))
                range_start = boundary
            base_ranges.append((range_start, total_frames))

            context_frames = round(QWEN_CHUNK_CONTEXT_SECONDS * sample_rate)
            for index, (base_start, base_end) in enumerate(base_ranges):
                chunk_start = (
                    base_start if index == 0 else max(base_start - context_frames, 0)
                )
                chunk_end = (
                    base_end
                    if index == len(base_ranges) - 1
                    else min(base_end + context_frames, total_frames)
                )
                audio.setpos(chunk_start)
                chunk_bytes = audio.readframes(chunk_end - chunk_start)
                chunk_samples = numpy.frombuffer(chunk_bytes, dtype="<i2").astype(
                    numpy.float32
                )
                chunk_samples /= PCM16_SCALE
                yield QwenAudioChunk(
                    samples=chunk_samples,
                    sample_rate=sample_rate,
                    start_seconds=chunk_start / sample_rate,
                    end_seconds=chunk_end / sample_rate,
                )
    except (OSError, wave.Error) as error:
        raise TranscriptionFailure("Qwen3-ASR 无法读取提取后的 WAV 音频") from error


def _split_qwen_audio_chunk(
    chunk: QwenAudioChunk,
    target_seconds: float,
) -> list[QwenAudioChunk]:
    return _split_qwen_samples(
        chunk.samples,
        chunk.sample_rate,
        start_seconds=chunk.start_seconds,
        target_seconds=target_seconds,
    )


def _split_qwen_samples(
    samples,
    sample_rate: int,
    start_seconds: float,
    target_seconds: float,
) -> list[QwenAudioChunk]:
    import numpy

    normalized_samples = numpy.asarray(samples, dtype=numpy.float32)
    total_samples = len(normalized_samples)
    if total_samples == 0:
        return []
    base_ranges = _qwen_low_energy_ranges(
        normalized_samples,
        sample_rate,
        target_seconds,
    )
    context_samples = round(QWEN_CHUNK_CONTEXT_SECONDS * sample_rate)
    chunks: list[QwenAudioChunk] = []
    for index, (base_start, base_end) in enumerate(base_ranges):
        chunk_start = base_start if index == 0 else max(base_start - context_samples, 0)
        chunk_end = (
            base_end
            if index == len(base_ranges) - 1
            else min(base_end + context_samples, total_samples)
        )
        absolute_start = start_seconds + (chunk_start / sample_rate)
        absolute_end = start_seconds + (chunk_end / sample_rate)
        chunks.append(
            QwenAudioChunk(
                samples=normalized_samples[chunk_start:chunk_end],
                sample_rate=sample_rate,
                start_seconds=absolute_start,
                end_seconds=absolute_end,
            )
        )
    return chunks


def _qwen_low_energy_ranges(
    samples,
    sample_rate: int,
    target_seconds: float,
) -> list[tuple[int, int]]:
    import numpy

    total_samples = len(samples)
    target_samples = max(round(target_seconds * sample_rate), 1)
    if total_samples <= target_samples:
        return [(0, total_samples)]
    search_samples = round(QWEN_BOUNDARY_SEARCH_SECONDS * sample_rate)
    energy_window_samples = max(
        round(QWEN_ENERGY_WINDOW_MILLISECONDS * sample_rate / MILLISECONDS_PER_SECOND),
        1,
    )
    ranges: list[tuple[int, int]] = []
    range_start = 0
    while total_samples - range_start > target_samples:
        target_boundary = range_start + target_samples
        search_start = max(
            range_start + energy_window_samples,
            target_boundary - search_samples,
        )
        search_end = min(
            total_samples - energy_window_samples,
            target_boundary + search_samples,
        )
        if search_end <= search_start:
            boundary = target_boundary
        else:
            search_region = numpy.abs(samples[search_start:search_end])
            window = numpy.ones(energy_window_samples, dtype=numpy.float32)
            energies = numpy.convolve(search_region, window, mode="valid")
            minimum_energy = float(numpy.min(energies))
            tolerance = max(minimum_energy * 0.05, 1e-8)
            low_energy_positions = numpy.flatnonzero(
                energies <= minimum_energy + tolerance
            )
            target_position = (
                target_boundary - search_start - energy_window_samples // 2
            )
            energy_position = min(
                (int(position) for position in low_energy_positions),
                key=lambda position: abs(position - target_position),
            )
            boundary = search_start + energy_position
            boundary += energy_window_samples // 2
        boundary = min(max(boundary, range_start + 1), total_samples)
        ranges.append((range_start, boundary))
        range_start = boundary
    ranges.append((range_start, total_samples))
    return ranges


def _qwen_generation_token_budget(duration_seconds: float) -> int:
    estimated_tokens = round(duration_seconds * QWEN_GENERATION_TOKENS_PER_SECOND)
    return min(
        max(estimated_tokens, QWEN_MIN_NEW_TOKENS),
        QWEN_MAX_NEW_TOKENS,
    )


def _qwen_chunk_quality(
    chunk: QwenAudioChunk,
    items: list[TimedText],
) -> QwenChunkQuality:
    import numpy

    samples = numpy.asarray(chunk.samples, dtype=numpy.float32)
    frame_samples = max(
        round(
            QWEN_ENERGY_WINDOW_MILLISECONDS
            * chunk.sample_rate
            / MILLISECONDS_PER_SECOND
        ),
        1,
    )
    frame_seconds = frame_samples / chunk.sample_rate
    frame_count = max((len(samples) + frame_samples - 1) // frame_samples, 1)
    speech_mask = _qwen_speech_activity_mask(
        samples,
        chunk.sample_rate,
        frame_samples,
        frame_count,
    )
    speech_frame_count = sum(speech_mask)
    if speech_frame_count == 0:
        return QwenChunkQuality(
            speech_seconds=0,
            covered_speech_ratio=1,
            max_uncovered_speech_seconds=0,
        )

    covered_mask = [False] * frame_count
    for item in items:
        relative_start = max(
            item.start_seconds - chunk.start_seconds - QWEN_ALIGNMENT_PADDING_SECONDS,
            0,
        )
        relative_end = min(
            item.end_seconds - chunk.start_seconds + QWEN_ALIGNMENT_PADDING_SECONDS,
            chunk.end_seconds - chunk.start_seconds,
        )
        start_frame = max(int(relative_start / frame_seconds), 0)
        end_frame = min(
            int(numpy.ceil(relative_end / frame_seconds)),
            frame_count,
        )
        for frame_index in range(start_frame, end_frame):
            covered_mask[frame_index] = True
    covered_speech_frames = sum(
        speech and covered
        for speech, covered in zip(speech_mask, covered_mask, strict=True)
    )
    uncovered_speech_mask = [
        speech and not covered
        for speech, covered in zip(speech_mask, covered_mask, strict=True)
    ]
    return QwenChunkQuality(
        speech_seconds=speech_frame_count * frame_seconds,
        covered_speech_ratio=covered_speech_frames / speech_frame_count,
        max_uncovered_speech_seconds=(
            _maximum_true_run(uncovered_speech_mask) * frame_seconds
        ),
    )


def _qwen_speech_activity_mask(
    samples,
    sample_rate: int,
    frame_samples: int,
    frame_count: int,
) -> list[bool]:
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    speech_ranges = get_speech_timestamps(
        samples,
        VadOptions(
            threshold=QWEN_VAD_THRESHOLD,
            min_speech_duration_ms=QWEN_VAD_MIN_SPEECH_MILLISECONDS,
            min_silence_duration_ms=QWEN_VAD_MIN_SILENCE_MILLISECONDS,
            speech_pad_ms=0,
        ),
        sampling_rate=sample_rate,
    )
    speech_mask = [False] * frame_count
    for speech_range in speech_ranges:
        start_frame = max(int(speech_range["start"] / frame_samples), 0)
        end_frame = min(
            int((speech_range["end"] + frame_samples - 1) / frame_samples),
            frame_count,
        )
        speech_mask[start_frame:end_frame] = [True] * (end_frame - start_frame)
    return speech_mask


def _maximum_true_run(values: list[bool]) -> int:
    maximum_length = 0
    current_length = 0
    for value in values:
        if value:
            current_length += 1
            maximum_length = max(maximum_length, current_length)
        else:
            current_length = 0
    return maximum_length


def _qwen_quality_is_acceptable(quality: QwenChunkQuality) -> bool:
    if quality.speech_seconds < QWEN_MIN_QUALITY_SPEECH_SECONDS:
        return True
    return (
        quality.covered_speech_ratio >= QWEN_MIN_SPEECH_COVERAGE
        and quality.max_uncovered_speech_seconds
        <= QWEN_MAX_UNCOVERED_SPEECH_SECONDS
    )


def _deduplicate_qwen_items(items: list[TimedText]) -> list[TimedText]:
    deduplicated: list[TimedText] = []
    for item in sorted(items, key=lambda candidate: candidate.start_seconds):
        if not deduplicated:
            deduplicated.append(item)
            continue
        previous = deduplicated[-1]
        overlaps = item.start_seconds <= previous.end_seconds
        if overlaps and item.text == previous.text:
            deduplicated[-1] = TimedText(
                text=previous.text,
                start_seconds=min(previous.start_seconds, item.start_seconds),
                end_seconds=max(previous.end_seconds, item.end_seconds),
            )
            continue
        deduplicated.append(item)
    return deduplicated


def _aggregate_qwen_segments(
    items: list[TimedText],
    language: str,
) -> list[TranscriptSegment]:
    segments: list[TranscriptSegment] = []
    current: list[TimedText] = []
    primary_language = language.split(",", maxsplit=1)[0]
    for item in items:
        if current:
            silence_duration = max(
                item.start_seconds - current[-1].end_seconds,
                0,
            )
            segment_duration = item.end_seconds - current[0].start_seconds
            if (
                silence_duration >= QWEN_SILENCE_BREAK_SECONDS
                or segment_duration > QWEN_MAX_SEGMENT_SECONDS
            ):
                segments.append(_qwen_segment(current, primary_language))
                current = []
        current.append(item)
        if item.text.rstrip()[-1:] in QWEN_SENTENCE_ENDINGS:
            segments.append(_qwen_segment(current, primary_language))
            current = []
    if current:
        segments.append(_qwen_segment(current, primary_language))
    return segments


def _qwen_segment(items: list[TimedText], language: str) -> TranscriptSegment:
    text = _join_alignment_text([item.text for item in items], language)
    return TranscriptSegment(
        start_seconds=items[0].start_seconds,
        end_seconds=max(items[-1].end_seconds, items[0].start_seconds),
        text=text,
    )


def _join_alignment_text(parts: list[str], language: str) -> str:
    if language in NO_SPACE_ALIGNMENT_LANGUAGES:
        return "".join(parts).strip()
    text = " ".join(part.strip() for part in parts if part.strip())
    return re.sub(r"\s+([,.;:!?])", r"\1", text).strip()


def _sensevoice_transcript(results: object, asset_id: str) -> Transcript:
    if not isinstance(results, list) or not results or not isinstance(results[0], dict):
        raise TranscriptionFailure("SenseVoice 没有返回有效结果")
    result = results[0]
    sentence_info = result.get(SENSEVOICE_SENTENCE_INFO_FIELD)
    if not isinstance(sentence_info, list) or not sentence_info:
        raise TranscriptionFailure("SenseVoice 未返回有效的分段时间戳")
    result_text = result.get(SENSEVOICE_TEXT_FIELD)
    fallback_labels = _sensevoice_labels(result_text if isinstance(result_text, str) else "")
    segments: list[TranscriptSegment] = []
    languages: list[str] = []
    for sentence in sentence_info:
        if not isinstance(sentence, dict):
            raise TranscriptionFailure("SenseVoice 返回了无效的分段时间戳")
        raw_text_value = sentence.get(SENSEVOICE_TEXT_FIELD)
        if not isinstance(raw_text_value, str):
            raw_text_value = sentence.get(SENSEVOICE_SENTENCE_FIELD)
        raw_text = raw_text_value if isinstance(raw_text_value, str) else ""
        start_milliseconds = _valid_milliseconds(sentence.get(SENSEVOICE_START_FIELD))
        end_milliseconds = _valid_milliseconds(sentence.get(SENSEVOICE_END_FIELD))
        if (
            start_milliseconds is None
            or end_milliseconds is None
            or end_milliseconds <= start_milliseconds
        ):
            raise TranscriptionFailure("SenseVoice 返回了无效的分段时间戳")
        labels = _sensevoice_labels(raw_text)
        language = labels[0] or fallback_labels[0]
        emotion = labels[1] or fallback_labels[1]
        audio_events = labels[2] or fallback_labels[2]
        if language:
            languages.append(language)
        text = SENSEVOICE_LANGUAGE_TAG.sub("", raw_text).strip()
        if not text:
            continue
        segments.append(
            TranscriptSegment(
                start_seconds=start_milliseconds / MILLISECONDS_PER_SECOND,
                end_seconds=end_milliseconds / MILLISECONDS_PER_SECOND,
                text=text,
                emotion=emotion,
                audio_events=audio_events,
            )
        )
    if not segments:
        raise TranscriptionFailure("SenseVoice 没有识别到可用的带时间戳文本")
    return Transcript(
        asset_id=asset_id,
        language=_merge_language_codes(languages) or None,
        segments=segments,
    )


def _sensevoice_labels(
    raw_text: str,
) -> tuple[
    str | None,
    TranscriptEmotion | None,
    list[TranscriptAudioEvent],
]:
    language: str | None = None
    emotion: TranscriptEmotion | None = None
    events: list[TranscriptAudioEvent] = []
    for tag in SENSEVOICE_LANGUAGE_TAG.findall(raw_text):
        normalized_tag = tag.strip().replace("-", "_")
        lowercase_tag = normalized_tag.lower()
        uppercase_tag = normalized_tag.upper()
        if lowercase_tag in SENSEVOICE_LANGUAGE_CODES:
            language = lowercase_tag
        elif uppercase_tag in SENSEVOICE_EMOTION_TAGS:
            emotion = SENSEVOICE_EMOTION_TAGS[uppercase_tag]
        elif uppercase_tag in SENSEVOICE_AUDIO_EVENT_TAGS:
            event = SENSEVOICE_AUDIO_EVENT_TAGS[uppercase_tag]
            if event not in events:
                events.append(event)
        elif uppercase_tag not in SENSEVOICE_CONTROL_TAGS:
            if TranscriptAudioEvent.UNKNOWN not in events:
                events.append(TranscriptAudioEvent.UNKNOWN)
    return language, emotion, events


def _valid_milliseconds(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        milliseconds = float(value)
    except (TypeError, ValueError):
        return None
    return milliseconds if milliseconds >= 0 else None


def _require_model_directory(
    models_root_directory: Path,
    engine: TranscriptionEngine,
    model: str,
    name: str,
) -> Path:
    try:
        directory = transcription_model_directory(
            models_root_directory,
            engine,
            model,
        )
    except Exception as error:
        raise TranscriptionFailure(f"{name} 本地目录无效") from error
    if not directory.is_dir():
        raise TranscriptionFailure(f"{name} 尚未安装或本地目录缺失")
    return directory


def _resolve_sensevoice_device(device: str, cuda_available: bool) -> str:
    if device == "auto":
        return CUDA_DEVICE_NAME if cuda_available else "cpu"
    if device == "cuda":
        if not cuda_available:
            raise TranscriptionFailure("SenseVoice 指定了 CUDA，但当前设备不可用")
        return CUDA_DEVICE_NAME
    return "cpu"


def _runtime_transcription_failure(
    engine_name: str,
    error: Exception,
) -> TranscriptionFailure:
    message = str(error).strip()
    if (
        error.__class__.__name__ == "OutOfMemoryError"
        or OUT_OF_MEMORY_ERROR_TEXT in message.lower()
    ):
        return TranscriptionFailure(f"{engine_name} 显存不足，请改用更小的模型")
    return TranscriptionFailure(f"{engine_name} 转录失败：{message or '未知错误'}")


def _release_cuda_memory(torch_module: object | None = None) -> None:
    gc.collect()
    if torch_module is None:
        try:
            import torch as torch_module
        except ModuleNotFoundError:
            return
    if torch_module.cuda.is_available():
        torch_module.cuda.empty_cache()


def _parse_json3_subtitles(path: Path) -> Transcript:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise TranscriptionFailure("字幕文件无法解析") from error

    events = payload.get("events", [])
    segments: list[TranscriptSegment] = []
    for event in events:
        if not isinstance(event, dict):
            continue
        text = _join_subtitle_text(event.get("segs"))
        if not text:
            continue
        start = _milliseconds(event.get("tStartMs"))
        duration = _milliseconds(event.get("dDurationMs"))
        segments.append(
            TranscriptSegment(
                start_seconds=start,
                end_seconds=max(start + duration, start),
                text=text,
            )
        )
    if not segments:
        return Transcript(asset_id="", segments=[])
    return Transcript(asset_id="", language=path.stem, segments=segments)


def _join_subtitle_text(segs: object) -> str:
    if not isinstance(segs, list):
        return ""
    parts = [
        part.get("utf8")
        for part in segs
        if isinstance(part, dict) and isinstance(part.get("utf8"), str)
    ]
    return "".join(parts).strip()


def _milliseconds(value: object) -> float:
    try:
        return max(float(value or 0) / 1000, 0)
    except (TypeError, ValueError):
        return 0


def _command_error(stderr: str, fallback: str) -> str:
    message = stderr.strip().splitlines()
    return message[-1] if message else fallback
