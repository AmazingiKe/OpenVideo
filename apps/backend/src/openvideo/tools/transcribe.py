"""从视频音轨或平台字幕生成带时间戳文本。

该模块把媒体处理与文字识别隔离：ffmpeg 负责稳定地抽取音频，yt-dlp
负责读取平台已经提供的字幕。没有可用字幕时，调用方可以接入任意
ASR 实现，而不需要改变转写结果的数据结构。
"""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from openvideo.core.analysis_models import Transcript, TranscriptSegment
from openvideo.tools.media import resolve_tool


AUDIO_SAMPLE_RATE = 16_000
AUDIO_CHANNELS = 1
COMMAND_TIMEOUT_SECONDS = 300
DEFAULT_WHISPER_MODEL = "small"
DEFAULT_WHISPER_LANGUAGE = "zh"
DEFAULT_WHISPER_COMPUTE_TYPE = "int8"


class TranscriptionFailure(RuntimeError):
    """媒体无法产生可用的带时间戳文本时抛出。"""


@dataclass(frozen=True)
class AudioExtractionResult:
    audio_path: Path


@dataclass(frozen=True)
class TranscriptionResult:
    transcript: Transcript
    output_source: str


class Transcriber(Protocol):
    """可插拔的文字识别实现，统一返回领域层 Transcript。"""

    def transcribe(self, audio_path: Path, asset_id: str) -> Transcript:
        ...


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
    subtitle_transcript = extract_platform_subtitles(source_url, work_directory / "subtitles")
    if subtitle_transcript:
        return TranscriptionResult(
            transcript=subtitle_transcript.model_copy(update={"asset_id": asset_id}),
            output_source="platform_subtitles",
        )
    if transcriber is None:
        raise TranscriptionFailure(
            "视频没有可用字幕；请配置本地 ASR（faster-whisper）后重试"
        )
    audio = extract_audio(media_path, work_directory / "audio", configured_ffmpeg_path, project_bin_dir)
    return TranscriptionResult(
        transcript=transcriber.transcribe(audio.audio_path, asset_id),
        output_source="faster-whisper",
    )


class FasterWhisperTranscriber:
    """基于 faster-whisper 的本地 ASR，CPU 上以 int8 量化保证可运行性。"""

    def __init__(
        self,
        model_size: str = DEFAULT_WHISPER_MODEL,
        model_directory: Path | None = None,
        language: str | None = DEFAULT_WHISPER_LANGUAGE,
        compute_type: str = DEFAULT_WHISPER_COMPUTE_TYPE,
    ) -> None:
        self.model_size = model_size
        self.model_directory = model_directory
        self.language = language
        self.compute_type = compute_type
        self._model = None

    def transcribe(self, audio_path: Path, asset_id: str) -> Transcript:
        if self._model is None:
            self._model = self._load_model()
        segments, info = self._model.transcribe(
            str(audio_path),
            language=self.language,
            vad_filter=True,
        )
        transcript_segments = [
            TranscriptSegment(
                start_seconds=segment.start,
                end_seconds=segment.end,
                text=segment.text.strip(),
            )
            for segment in segments
            if segment.text.strip()
        ]
        return Transcript(
            asset_id=asset_id,
            language=info.language,
            segments=transcript_segments,
        )

    def _load_model(self):
        # 延迟导入，避免未安装 ASR 依赖时阻塞其他功能。
        from faster_whisper import WhisperModel

        model_directory = self.model_directory
        if model_directory:
            model_directory.mkdir(parents=True, exist_ok=True)
        return WhisperModel(
            self.model_size,
            device="cpu",
            compute_type=self.compute_type,
            download_root=str(model_directory) if model_directory else None,
        )


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
