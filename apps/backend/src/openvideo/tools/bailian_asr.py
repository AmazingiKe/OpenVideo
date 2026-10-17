"""把百炼异步录音识别转换为播放器可直接使用的句级时间轴。"""

from __future__ import annotations

import io
import math
import re
import time
import wave
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import TypeVar
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, Field, ValidationError

from openvideo.core.bailian_models import BAILIAN_API_BASE_URLS, BailianRegion
from openvideo.core.identifiers import uuid7
from openvideo.tools.cancellation import AnalysisCancelled
from openvideo.core.transcription_models import (
    BAILIAN_FUN_ASR_MODEL,
    BAILIAN_PARAFORMER_MODEL,
    Transcript,
    TranscriptSegment,
    TranscriptionEngine,
    TranscriptionOptions,
)


DEFAULT_BAILIAN_BASE_URL = BAILIAN_API_BASE_URLS[BailianRegion.BEIJING]
SUPPORTED_MODELS = frozenset({BAILIAN_FUN_ASR_MODEL, BAILIAN_PARAFORMER_MODEL})
MAX_AUDIO_BYTES = 2 * 1024**3
MAX_AUDIO_SECONDS = 12 * 60 * 60
BYTES_PER_MEGABYTE = 1024**2
MILLISECONDS_PER_SECOND = 1_000
TIMESTAMP_TOLERANCE_SECONDS = 1
REQUEST_TIMEOUT_SECONDS = 30
UPLOAD_TIMEOUT_SECONDS = 300
TASK_TIMEOUT_SECONDS = 6 * 60 * 60
POLL_INTERVAL_SECONDS = 3
CANCELLATION_INTERVAL_SECONDS = 0.2
MAX_RESULT_BYTES = 64 * 1024**2
AUDIO_SAMPLE_RATE = 16_000
AUDIO_CHANNELS = 1
AUDIO_SAMPLE_WIDTH = 2
WAV_CONTENT_TYPE = "audio/wav"
MP3_CONTENT_TYPE = "audio/mpeg"
FIRST_AUDIO_CHANNEL = 0
API_BASE_PATH = "/api/v1"
UPLOAD_POLICY_PATH = "/uploads"
TRANSCRIPTION_PATH = "/services/audio/asr/transcription"
TASK_PATH = "/tasks"
TASK_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,128}")
API_HOSTS = frozenset({"dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"})
NO_SPEECH_MESSAGE = "百炼未检测到可识别语音，未生成转写结果"
INVALID_RESPONSE_MESSAGE = "百炼返回的数据不完整或格式异常，请稍后重试"
ResponseModel = TypeVar("ResponseModel", bound=BaseModel)


class BailianAsrError(RuntimeError):
    """区分仍可继续查询的错误与供应商已确认终止的任务，避免重复计费。"""

    def __init__(self, message: str, *, terminal_task: bool = False):
        super().__init__(message)
        self.terminal_task = terminal_task


class TaskStatus(StrEnum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    CANCELED = "CANCELED"
    UNKNOWN = "UNKNOWN"


class UploadPolicy(BaseModel):
    policy: str = Field(min_length=1)
    signature: str = Field(min_length=1)
    upload_dir: str = Field(min_length=1)
    upload_host: str = Field(min_length=1)
    max_file_size_mb: float = Field(gt=0, allow_inf_nan=False)
    oss_access_key_id: str = Field(min_length=1)
    x_oss_object_acl: str
    x_oss_forbid_overwrite: str


class UploadPolicyResponse(BaseModel):
    data: UploadPolicy


class TaskResult(BaseModel):
    subtask_status: TaskStatus
    transcription_url: str | None = None
    code: str | None = None


class TaskOutput(BaseModel):
    task_id: str
    task_status: TaskStatus
    results: list[TaskResult] = Field(default_factory=list)
    code: str | None = None


class TaskResponse(BaseModel):
    output: TaskOutput


class Sentence(BaseModel):
    begin_time: float = Field(ge=0, allow_inf_nan=False)
    end_time: float = Field(ge=0, allow_inf_nan=False)
    text: str


class ChannelTranscript(BaseModel):
    channel_id: int = Field(ge=0)
    text: str = ""
    sentences: list[Sentence] = Field(default_factory=list)


class RecognitionResult(BaseModel):
    transcripts: list[ChannelTranscript]


@dataclass(frozen=True)
class AudioInput:
    """在产生上传或计费行为之前固定已验证的音频规格。"""

    size_bytes: int
    duration_seconds: float
    content_type: str
    suffix: str


class CancellableAudio(io.BufferedReader):
    """在 HTTP 分块读取音频时检查取消，避免大文件上传期间失去响应。"""

    def __init__(self, audio_path: Path, cancellation_check: Callable[[], None]):
        super().__init__(io.FileIO(audio_path, "rb"))
        self._cancellation_check = cancellation_check

    def read(self, size: int = -1) -> bytes:
        self._cancellation_check()
        return super().read(size)


class BailianTranscriber:
    """提交一次收费任务，并允许用已持久化的云端任务号继续取回结果。"""

    engine = TranscriptionEngine.BAILIAN

    def __init__(
        self,
        options: TranscriptionOptions,
        api_key: str,
        base_url: str = DEFAULT_BAILIAN_BASE_URL,
        *,
        cancellation_check: Callable[[], None] | None = None,
        task_id: str | None = None,
        on_task_submitted: Callable[[str], None] | None = None,
        on_submission_started: Callable[[], None] | None = None,
        on_submission_rejected: Callable[[], None] | None = None,
        on_status: Callable[[str], None] | None = None,
        duration_seconds: float | None = None,
    ):
        if options.engine != self.engine or options.model not in SUPPORTED_MODELS:
            raise BailianAsrError("请选择百炼 Fun-ASR 或 Paraformer 转写模型")
        self._base_url = _validate_base_url(base_url)
        self._options = options
        self._headers = _authorization_headers(api_key)
        self._cancellation_check = cancellation_check
        self._on_task_submitted = on_task_submitted
        self._on_submission_started = on_submission_started
        self._on_submission_rejected = on_submission_rejected
        self._on_status = on_status
        self._duration_seconds = duration_seconds
        self._task_id = _validate_task_id(task_id) if task_id else None
        self._client = httpx.Client(
            timeout=REQUEST_TIMEOUT_SECONDS, follow_redirects=False
        )
        self.output_source = f"bailian/{options.model}"

    def transcribe(self, audio_path: Path, asset_id: str) -> Transcript:
        self._check_cancellation()
        audio = _validate_audio(audio_path, self._duration_seconds)
        if self._task_id is None:
            self._report_status("正在上传音频到百炼临时存储")
            policy = _get_upload_policy(
                self._client, self._base_url, self._headers, self._options.model
            )
            audio_url = self._upload_audio(audio_path, audio, policy)
            self._check_cancellation()
            self._report_status("正在提交百炼转写任务")
            self._task_id = self._submit_task(audio_url)
            # 必须先保存云端任务号，再响应取消，以便重启后继续查询而非重新计费。
            if self._on_task_submitted:
                self._on_task_submitted(self._task_id)
        self._check_cancellation()
        result_url = self._wait_for_task(self._task_id)
        self._report_status("正在读取百炼转写结果")
        result = self._download_result(result_url)
        return _build_transcript(result, audio, asset_id, self._options.language)

    def close(self) -> None:
        self._client.close()

    def _check_cancellation(self) -> None:
        if self._cancellation_check:
            self._cancellation_check()

    def _report_status(self, message: str) -> None:
        if self._on_status:
            self._on_status(message)

    def _upload_audio(
        self, audio_path: Path, audio: AudioInput, policy: UploadPolicy
    ) -> str:
        if audio.size_bytes > policy.max_file_size_mb * BYTES_PER_MEGABYTE:
            raise BailianAsrError("音频超过百炼临时上传大小上限，请缩短视频后重试")
        upload_host = _validate_storage_url(policy.upload_host)
        object_name = f"audio-{uuid7().hex}{audio.suffix}"
        object_key = f"{policy.upload_dir.rstrip('/')}/{object_name}"
        form = {
            "OSSAccessKeyId": policy.oss_access_key_id,
            "Signature": policy.signature,
            "policy": policy.policy,
            "x-oss-object-acl": policy.x_oss_object_acl,
            "x-oss-forbid-overwrite": policy.x_oss_forbid_overwrite,
            "key": object_key,
            "success_action_status": "200",
        }
        self._check_cancellation()
        try:
            with CancellableAudio(audio_path, self._check_cancellation) as audio_file:
                response = self._client.post(
                    upload_host,
                    data=form,
                    files={"file": (object_name, audio_file, audio.content_type)},
                    timeout=UPLOAD_TIMEOUT_SECONDS,
                )
        except httpx.HTTPError:
            raise BailianAsrError("百炼音频上传失败，请检查网络后重试") from None
        except OSError:
            raise BailianAsrError("音频文件无法读取，请重新提取音轨") from None
        _check_http_response(response, "音频上传")
        return f"oss://{object_key}"

    def _submit_task(self, audio_url: str) -> str:
        parameters: dict[str, object] = {"channel_id": [FIRST_AUDIO_CHANNEL]}
        language = self._options.language
        if language and language != "auto":
            parameters["language_hints"] = [language]
        headers = {
            **self._headers,
            "X-DashScope-Async": "enable",
            "X-DashScope-OssResourceResolve": "enable",
        }
        # 提交结果不确定时不自动重试，避免重复创建收费任务。
        try:
            self._check_cancellation()
            if self._on_submission_started:
                self._on_submission_started()
            self._check_cancellation()
        except AnalysisCancelled:
            if self._on_submission_rejected:
                self._on_submission_rejected()
            raise
        try:
            response = self._client.post(
                f"{self._base_url}{TRANSCRIPTION_PATH}",
                headers=headers,
                json={
                    "model": self._options.model,
                    "input": {"file_urls": [audio_url]},
                    "parameters": parameters,
                },
            )
        except httpx.HTTPError:
            raise BailianAsrError(
                "百炼任务提交结果未确认，请先在百炼控制台核实，避免重复计费"
            ) from None
        if response.is_client_error and self._on_submission_rejected:
            self._on_submission_rejected()
        _check_http_response(response, "任务提交")
        output = _parse_response(response, TaskResponse).output
        return _validate_task_id(output.task_id)

    def _wait_for_task(self, task_id: str) -> str:
        deadline = time.monotonic() + TASK_TIMEOUT_SECONDS
        last_status: TaskStatus | None = None
        while time.monotonic() < deadline:
            self._check_cancellation()
            try:
                response = self._client.get(
                    f"{self._base_url}{TASK_PATH}/{task_id}", headers=self._headers
                )
            except httpx.HTTPError:
                raise BailianAsrError(
                    "百炼任务查询失败，已保留任务号，可重试继续查询"
                ) from None
            _check_http_response(response, "任务查询")
            output = _parse_response(response, TaskResponse).output
            if output.task_id != task_id:
                raise BailianAsrError(INVALID_RESPONSE_MESSAGE)
            if output.task_status == TaskStatus.SUCCEEDED:
                if len(output.results) != 1:
                    raise BailianAsrError(INVALID_RESPONSE_MESSAGE)
                result = output.results[0]
                if result.subtask_status != TaskStatus.SUCCEEDED:
                    raise BailianAsrError(
                        _task_error_message(result.code), terminal_task=True
                    )
                if not result.transcription_url:
                    raise BailianAsrError(INVALID_RESPONSE_MESSAGE)
                return _validate_storage_url(result.transcription_url)
            if output.task_status not in {TaskStatus.PENDING, TaskStatus.RUNNING}:
                raise BailianAsrError(
                    _task_error_message(output.code), terminal_task=True
                )
            if output.task_status != last_status:
                message = (
                    "百炼任务正在排队"
                    if output.task_status == TaskStatus.PENDING
                    else "百炼正在识别音频"
                )
                self._report_status(message)
                last_status = output.task_status
            self._wait_until_next_poll(deadline)
        raise BailianAsrError("等待百炼转写超时，已保留任务号，可重试继续查询")

    def _wait_until_next_poll(self, deadline: float) -> None:
        next_poll = min(deadline, time.monotonic() + POLL_INTERVAL_SECONDS)
        while time.monotonic() < next_poll:
            self._check_cancellation()
            remaining = next_poll - time.monotonic()
            if remaining > 0:
                time.sleep(min(CANCELLATION_INTERVAL_SECONDS, remaining))

    def _download_result(self, result_url: str) -> RecognitionResult:
        self._check_cancellation()
        content = bytearray()
        try:
            # OSS 签名 URL 已携带授权，不能把百炼 API Key 转发给存储服务。
            with self._client.stream("GET", result_url) as response:
                _check_http_response(response, "结果下载")
                for chunk in response.iter_bytes():
                    self._check_cancellation()
                    content.extend(chunk)
                    if len(content) > MAX_RESULT_BYTES:
                        raise BailianAsrError("百炼识别结果超过可处理大小")
        except httpx.HTTPError:
            raise BailianAsrError(
                "百炼识别结果下载失败，结果链接有效期为24小时，请及时重试"
            ) from None
        try:
            return RecognitionResult.model_validate_json(content)
        except ValidationError:
            raise BailianAsrError(INVALID_RESPONSE_MESSAGE) from None


def test_bailian_connection(
    api_key: str, base_url: str = DEFAULT_BAILIAN_BASE_URL
) -> None:
    """用不上传文件、不创建收费任务的凭证请求验证账号访问权限。"""
    validated_url = _validate_base_url(base_url)
    headers = _authorization_headers(api_key)
    with httpx.Client(
        timeout=REQUEST_TIMEOUT_SECONDS, follow_redirects=False
    ) as client:
        _get_upload_policy(client, validated_url, headers, BAILIAN_FUN_ASR_MODEL)


def _get_upload_policy(
    client: httpx.Client, base_url: str, headers: dict[str, str], model: str
) -> UploadPolicy:
    try:
        response = client.get(
            f"{base_url}{UPLOAD_POLICY_PATH}",
            headers={**headers, "Content-Type": "application/json"},
            params={"action": "getPolicy", "model": model},
        )
    except httpx.HTTPError:
        raise BailianAsrError("无法连接百炼，请检查网络或服务地址") from None
    _check_http_response(response, "获取上传凭证")
    return _parse_response(response, UploadPolicyResponse).data


def _parse_response(
    response: httpx.Response, model: type[ResponseModel]
) -> ResponseModel:
    try:
        return model.model_validate_json(response.content)
    except ValidationError:
        raise BailianAsrError(INVALID_RESPONSE_MESSAGE) from None


def _check_http_response(response: httpx.Response, stage: str) -> None:
    if response.is_success:
        return
    if response.status_code in {401, 403}:
        raise BailianAsrError(
            "百炼鉴权或访问权限校验失败，请检查 API Key、地域及服务开通状态"
        )
    if response.status_code == 429:
        raise BailianAsrError("百炼请求过于频繁或额度不足，请检查账号额度后重试")
    if response.status_code == 404:
        raise BailianAsrError(
            "百炼服务或任务不存在，任务结果可能已超过24小时有效期",
            terminal_task=True,
        )
    raise BailianAsrError(f"百炼{stage}失败，请检查账号配置或稍后重试")


def _task_error_message(code: str | None) -> str:
    messages = {
        "FILE_DOWNLOAD_FAILED": "百炼无法读取音频，请检查上传文件有效期后重试",
        "UNSUPPORTED_FORMAT": "百炼不支持该音频格式，请重新提取音轨",
        "DECODE_ERROR": "百炼无法解码音频，请重新提取音轨",
        "ASR_RESPONSE_HAVE_NO_WORDS": NO_SPEECH_MESSAGE,
    }
    return messages.get(code, "百炼转写任务未完成，请在百炼控制台检查任务和账号状态")


def _validate_base_url(base_url: str) -> str:
    try:
        parsed = urlsplit(base_url.strip())
        port = parsed.port
    except ValueError:
        raise BailianAsrError("百炼 API 地址格式异常，请检查后重试") from None
    host = parsed.hostname or ""
    allowed_host = host in API_HOSTS or host.endswith(".maas.aliyuncs.com")
    valid_url = (
        parsed.scheme == "https"
        and allowed_host
        and port in {None, 443}
        and not parsed.username
        and not parsed.password
        and not parsed.query
        and not parsed.fragment
        and parsed.path.rstrip("/") == API_BASE_PATH
    )
    if not valid_url:
        raise BailianAsrError("请填写阿里云百炼官方 HTTPS API 地址，路径需为 /api/v1")
    return base_url.strip().rstrip("/")


def _validate_storage_url(url: str) -> str:
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        raise BailianAsrError("百炼返回了无效的存储服务地址") from None
    host = parsed.hostname or ""
    valid_url = (
        parsed.scheme == "https"
        and host.endswith(".aliyuncs.com")
        and port in {None, 443}
        and not parsed.username
        and not parsed.password
        and not parsed.fragment
    )
    if not valid_url:
        raise BailianAsrError("百炼返回了无效的存储服务地址")
    return url


def _authorization_headers(api_key: str) -> dict[str, str]:
    """提前拒绝不能作为请求头的凭证，避免底层编码异常包含密钥原文。"""
    key = api_key.strip()
    if not key:
        raise BailianAsrError("请先在转写设置中配置百炼 API Key")
    if (
        not key.isascii()
        or not key.isprintable()
        or any(char.isspace() for char in key)
    ):
        raise BailianAsrError("百炼 API Key 格式异常，请检查是否复制了额外内容")
    return {"Authorization": f"Bearer {key}"}


def _validate_task_id(task_id: str) -> str:
    if not TASK_ID_PATTERN.fullmatch(task_id):
        raise BailianAsrError("百炼任务号格式异常，无法继续查询")
    return task_id


def _validate_audio(audio_path: Path, duration_seconds: float | None) -> AudioInput:
    try:
        if not audio_path.is_file():
            raise BailianAsrError("音频文件不存在，请重新提取音轨")
        size_bytes = audio_path.stat().st_size
        if size_bytes > MAX_AUDIO_BYTES:
            raise BailianAsrError("百炼单个音频文件不能超过2GB，请缩短视频")
        suffix = audio_path.suffix.lower()
        if suffix == ".wav":
            duration_seconds = _wav_duration(audio_path)
            content_type = WAV_CONTENT_TYPE
        elif suffix == ".mp3":
            with audio_path.open("rb") as audio_file:
                header = audio_file.read(3)
            has_id3 = header.startswith(b"ID3")
            has_frame = (
                len(header) >= 2 and header[0] == 0xFF and header[1] & 0xE0 == 0xE0
            )
            if not has_id3 and not has_frame:
                raise BailianAsrError("音频不是有效的 MP3 文件，请重新提取音轨")
            content_type = MP3_CONTENT_TYPE
        else:
            raise BailianAsrError("百炼转写需要提取后的 WAV 或 MP3 音频")
    except (OSError, wave.Error, EOFError):
        raise BailianAsrError("音频文件无法读取或已损坏，请重新提取音轨") from None
    if (
        duration_seconds is None
        or not math.isfinite(duration_seconds)
        or duration_seconds <= 0
    ):
        raise BailianAsrError("缺少有效的音频时长，无法提交百炼转写")
    if duration_seconds > MAX_AUDIO_SECONDS:
        raise BailianAsrError("百炼单个音频不能超过12小时，请缩短视频")
    return AudioInput(size_bytes, duration_seconds, content_type, suffix)


def _wav_duration(audio_path: Path) -> float:
    with wave.open(str(audio_path), "rb") as audio_file:
        valid_format = (
            audio_file.getnchannels() == AUDIO_CHANNELS
            and audio_file.getsampwidth() == AUDIO_SAMPLE_WIDTH
            and audio_file.getframerate() == AUDIO_SAMPLE_RATE
            and audio_file.getcomptype() == "NONE"
        )
        if not valid_format:
            raise BailianAsrError("请将音轨提取为16kHz单声道16位 PCM WAV 后重试")
        frame_count = audio_file.getnframes()
        if frame_count > 0:
            audio_file.setpos(frame_count - 1)
            if len(audio_file.readframes(1)) != AUDIO_SAMPLE_WIDTH:
                raise BailianAsrError("音频文件不完整，请重新提取音轨")
        return frame_count / audio_file.getframerate()


def _build_transcript(
    result: RecognitionResult, audio: AudioInput, asset_id: str, language: str | None
) -> Transcript:
    segments: list[TranscriptSegment] = []
    for channel in result.transcripts:
        if channel.channel_id != FIRST_AUDIO_CHANNEL:
            raise BailianAsrError("百炼返回了未请求的音轨，无法生成可靠时间轴")
        if channel.text.strip() and not channel.sentences:
            raise BailianAsrError("百炼返回的文字缺少句级时间戳，无法生成字幕")
        for sentence in channel.sentences:
            text = sentence.text.strip()
            if not text:
                continue
            start_seconds = sentence.begin_time / MILLISECONDS_PER_SECOND
            end_seconds = sentence.end_time / MILLISECONDS_PER_SECOND
            maximum_end = audio.duration_seconds + TIMESTAMP_TOLERANCE_SECONDS
            if end_seconds <= start_seconds or end_seconds > maximum_end:
                raise BailianAsrError("百炼返回的字幕时间戳异常，未保存转写结果")
            segments.append(
                TranscriptSegment(
                    start_seconds=start_seconds, end_seconds=end_seconds, text=text
                )
            )
    if not segments:
        raise BailianAsrError(NO_SPEECH_MESSAGE)
    segments.sort(key=lambda segment: (segment.start_seconds, segment.end_seconds))
    return Transcript(
        asset_id=asset_id,
        language=None if language == "auto" else language,
        segments=segments,
    )
