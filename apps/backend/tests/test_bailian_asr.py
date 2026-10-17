import json
import wave
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest

from openvideo.core.transcription_models import (
    BAILIAN_FUN_ASR_MODEL,
    BAILIAN_PARAFORMER_MODEL,
    TranscriptionComputeType,
    TranscriptionDevice,
    TranscriptionEngine,
    TranscriptionOptions,
)
from openvideo.tools import bailian_asr
from openvideo.tools.bailian_asr import BailianAsrError, BailianTranscriber
from openvideo.tools.cancellation import AnalysisCancelled


API_KEY = "sk-secret-test-value"
TASK_ID = "cloud-task-123"
UPLOAD_HOST = "https://dashscope-file-test.oss-cn-beijing.aliyuncs.com"
RESULT_URL = "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.json?Signature=secret-signature"


def cloud_options(model: str = BAILIAN_FUN_ASR_MODEL) -> TranscriptionOptions:
    return TranscriptionOptions(
        engine=TranscriptionEngine.BAILIAN,
        model=model,
        language="zh",
        device=TranscriptionDevice.AUTO,
        compute_type=TranscriptionComputeType.AUTO,
    )


def policy_response(max_file_size_mb: float = 100) -> dict:
    return {
        "data": {
            "policy": "test-policy",
            "signature": "secret-signature",
            "upload_dir": "dashscope-instant/account/day/upload",
            "upload_host": UPLOAD_HOST,
            "max_file_size_mb": max_file_size_mb,
            "oss_access_key_id": "temporary-access-key",
            "x_oss_object_acl": "private",
            "x_oss_forbid_overwrite": "true",
        }
    }


def completed_task(**result_fields: object) -> dict:
    return {
        "output": {
            "task_id": TASK_ID,
            "task_status": "SUCCEEDED",
            "results": [
                {
                    "subtask_status": "SUCCEEDED",
                    "transcription_url": RESULT_URL,
                    **result_fields,
                }
            ],
        }
    }


def recognition_result() -> dict:
    return {
        "transcripts": [
            {
                "channel_id": 0,
                "text": "第一句。第二句。",
                "sentences": [
                    {"begin_time": 1500, "end_time": 2500, "text": " 第二句。 "},
                    {"begin_time": 100, "end_time": 1000, "text": "第一句。"},
                ],
            }
        ]
    }


@pytest.fixture
def audio_path(tmp_path: Path) -> Path:
    path = tmp_path / "private-original-name.wav"
    with wave.open(str(path), "wb") as audio_file:
        audio_file.setnchannels(1)
        audio_file.setsampwidth(2)
        audio_file.setframerate(16000)
        audio_file.writeframes(b"\x00\x00" * 16000 * 3)
    return path


@pytest.fixture
def mock_http(monkeypatch: pytest.MonkeyPatch):
    original_client = httpx.Client
    requests: list[httpx.Request] = []

    def install(handler: Callable[[httpx.Request], httpx.Response]):
        def record(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return handler(request)

        def create_client(**kwargs: object) -> httpx.Client:
            return original_client(transport=httpx.MockTransport(record), **kwargs)

        monkeypatch.setattr(bailian_asr.httpx, "Client", create_client)
        monkeypatch.setattr(bailian_asr, "POLL_INTERVAL_SECONDS", 0)
        return requests

    return install


def successful_handler(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith("/uploads"):
        return httpx.Response(200, json=policy_response())
    if request.url.host == httpx.URL(UPLOAD_HOST).host:
        return httpx.Response(200)
    if request.url.path.endswith("/transcription"):
        return httpx.Response(
            200, json={"output": {"task_id": TASK_ID, "task_status": "PENDING"}}
        )
    if request.url.path.endswith(f"/tasks/{TASK_ID}"):
        return httpx.Response(200, json=completed_task())
    if str(request.url) == RESULT_URL:
        return httpx.Response(200, json=recognition_result())
    raise AssertionError(f"Unexpected request: {request.method} {request.url}")


@pytest.mark.parametrize("model", [BAILIAN_FUN_ASR_MODEL, BAILIAN_PARAFORMER_MODEL])
def test_transcribes_uploaded_audio_with_sentence_timestamps(
    model: str, audio_path: Path, mock_http
):
    requests = mock_http(successful_handler)
    submitted: list[str] = []
    transcriber = BailianTranscriber(
        cloud_options(model), API_KEY, on_task_submitted=submitted.append
    )
    try:
        transcript = transcriber.transcribe(audio_path, "asset-example")
    finally:
        transcriber.close()

    assert submitted == [TASK_ID]
    assert transcript.asset_id == "asset-example"
    assert transcript.language == "zh"
    assert [
        (segment.start_seconds, segment.end_seconds, segment.text)
        for segment in transcript.segments
    ] == [
        (0.1, 1.0, "第一句。"),
        (1.5, 2.5, "第二句。"),
    ]
    assert transcriber.output_source == f"bailian/{model}"
    assert requests[0].url.params["model"] == model
    assert requests[0].headers["Authorization"] == f"Bearer {API_KEY}"
    upload = requests[1]
    assert "Authorization" not in upload.headers
    assert audio_path.name.encode() not in upload.content
    assert b'name="success_action_status"' in upload.content
    assert upload.content.rfind(b'name="file"') > upload.content.rfind(b'name="key"')
    submission = requests[2]
    payload = json.loads(submission.content)
    assert payload["model"] == model
    assert payload["parameters"] == {"channel_id": [0], "language_hints": ["zh"]}
    assert payload["input"]["file_urls"][0].startswith("oss://dashscope-instant/")
    assert submission.headers["X-DashScope-Async"] == "enable"
    assert submission.headers["X-DashScope-OssResourceResolve"] == "enable"
    assert "Authorization" not in requests[-1].headers


def test_resumes_cloud_task_without_uploading_or_submitting(
    audio_path: Path, mock_http
):
    requests = mock_http(successful_handler)
    submitted: list[str] = []
    transcriber = BailianTranscriber(
        cloud_options(), API_KEY, task_id=TASK_ID, on_task_submitted=submitted.append
    )
    try:
        assert len(transcriber.transcribe(audio_path, "asset-example").segments) == 2
    finally:
        transcriber.close()
    assert submitted == []
    assert [request.method for request in requests] == ["GET", "GET"]
    assert requests[0].url.path.endswith(f"/tasks/{TASK_ID}")


def test_accepts_compressed_mp3_with_known_duration(tmp_path: Path, mock_http):
    path = tmp_path / "audio.mp3"
    path.write_bytes(b"ID3" + b"test-mp3-content")
    requests = mock_http(successful_handler)
    transcriber = BailianTranscriber(cloud_options(), API_KEY, duration_seconds=3)
    try:
        assert transcriber.transcribe(path, "asset-example").segments
    finally:
        transcriber.close()
    assert b"Content-Type: audio/mpeg" in requests[1].content


def test_connection_test_only_gets_free_upload_policy(mock_http):
    requests = mock_http(successful_handler)
    bailian_asr.test_bailian_connection(API_KEY, bailian_asr.DEFAULT_BAILIAN_BASE_URL)
    assert len(requests) == 1
    assert requests[0].method == "GET"
    assert requests[0].url.path.endswith("/uploads")
    assert requests[0].url.params["model"] == BAILIAN_FUN_ASR_MODEL


def test_reports_real_cloud_stages_and_saves_id_before_poll(
    audio_path: Path, mock_http
):
    statuses = ["PENDING", "PENDING", "RUNNING"]
    events: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith(f"/tasks/{TASK_ID}"):
            assert TASK_ID in events
            if statuses:
                return httpx.Response(
                    200,
                    json={
                        "output": {"task_id": TASK_ID, "task_status": statuses.pop(0)}
                    },
                )
        return successful_handler(request)

    mock_http(handler)
    transcriber = BailianTranscriber(
        cloud_options(),
        API_KEY,
        on_task_submitted=events.append,
        on_status=events.append,
    )
    try:
        transcriber.transcribe(audio_path, "asset-example")
    finally:
        transcriber.close()
    assert events == [
        "正在上传音频到百炼临时存储",
        "正在提交百炼转写任务",
        TASK_ID,
        "百炼任务正在排队",
        "百炼正在识别音频",
        "正在读取百炼转写结果",
    ]


@pytest.mark.parametrize(
    "invalid_audio", ["missing", "corrupt", "empty", "stereo", "truncated"]
)
def test_rejects_invalid_wav_before_any_network_request(
    invalid_audio: str, tmp_path: Path, mock_http
):
    path = tmp_path / "audio.wav"
    if invalid_audio == "corrupt":
        path.write_bytes(b"not-wav")
    elif invalid_audio != "missing":
        with wave.open(str(path), "wb") as audio_file:
            audio_file.setnchannels(2 if invalid_audio == "stereo" else 1)
            audio_file.setsampwidth(2)
            audio_file.setframerate(16000)
            audio_file.writeframes(
                b"" if invalid_audio == "empty" else b"\x00\x00" * 16000
            )
        if invalid_audio == "truncated":
            path.write_bytes(path.read_bytes()[:-2])
    requests = mock_http(successful_handler)
    transcriber = BailianTranscriber(cloud_options(), API_KEY)
    try:
        with pytest.raises(BailianAsrError):
            transcriber.transcribe(path, "asset-example")
    finally:
        transcriber.close()
    assert requests == []


@pytest.mark.parametrize("duration", [None, 0, float("nan"), float("inf"), 43201])
def test_requires_valid_mp3_duration_before_upload(duration, tmp_path: Path, mock_http):
    path = tmp_path / "audio.mp3"
    path.write_bytes(b"ID3test")
    requests = mock_http(successful_handler)
    transcriber = BailianTranscriber(
        cloud_options(), API_KEY, duration_seconds=duration
    )
    try:
        with pytest.raises(BailianAsrError):
            transcriber.transcribe(path, "asset-example")
    finally:
        transcriber.close()
    assert requests == []


def test_checks_model_and_upload_policy_size_limits(
    audio_path: Path, mock_http, monkeypatch: pytest.MonkeyPatch
):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=policy_response(max_file_size_mb=0.001))

    requests = mock_http(handler)
    transcriber = BailianTranscriber(cloud_options(), API_KEY)
    try:
        with pytest.raises(BailianAsrError, match="临时上传大小上限"):
            transcriber.transcribe(audio_path, "asset-example")
        assert len(requests) == 1
        requests.clear()
        monkeypatch.setattr(bailian_asr, "MAX_AUDIO_BYTES", 100)
        with pytest.raises(BailianAsrError, match="2GB"):
            transcriber.transcribe(audio_path, "asset-example")
        assert requests == []
    finally:
        transcriber.close()


@pytest.mark.parametrize("status", [401, 403, 429, 500])
def test_hides_api_key_and_signed_urls_from_http_errors(status: int, mock_http):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status, json={"message": f"secret {API_KEY} {RESULT_URL}"}
        )

    mock_http(handler)
    with pytest.raises(BailianAsrError) as error:
        bailian_asr.test_bailian_connection(API_KEY)
    assert API_KEY not in str(error.value)
    assert RESULT_URL not in str(error.value)
    assert "secret-signature" not in str(error.value)


def test_does_not_retry_ambiguous_paid_submission(audio_path: Path, mock_http):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/transcription"):
            raise httpx.ReadTimeout(f"secret {API_KEY} {RESULT_URL}", request=request)
        return successful_handler(request)

    requests = mock_http(handler)
    submitted: list[str] = []
    transcriber = BailianTranscriber(
        cloud_options(), API_KEY, on_task_submitted=submitted.append
    )
    try:
        with pytest.raises(BailianAsrError, match="避免重复计费") as error:
            transcriber.transcribe(audio_path, "asset-example")
    finally:
        transcriber.close()
    assert sum(request.url.path.endswith("/transcription") for request in requests) == 1
    assert submitted == []
    assert API_KEY not in str(error.value)


@pytest.mark.parametrize("outcome", ["cancel_before_post", "timeout", "rejected"])
def test_submission_marker_distinguishes_unsent_rejected_and_unknown_requests(
    outcome, mock_http
):
    states = []
    cancel = False

    def check_cancel():
        if cancel:
            raise AnalysisCancelled("分析已停止")

    def started():
        nonlocal cancel
        states.append(True)
        cancel = outcome == "cancel_before_post"

    def handle(request):
        if outcome == "timeout":
            raise httpx.ReadTimeout("submission uncertain", request=request)
        return httpx.Response(401, json={"code": "InvalidApiKey"})

    requests = mock_http(handle)
    transcriber = BailianTranscriber(
        cloud_options(),
        API_KEY,
        cancellation_check=check_cancel,
        on_submission_started=started,
        on_submission_rejected=lambda: states.append(False),
    )
    try:
        with pytest.raises(
            AnalysisCancelled if outcome == "cancel_before_post" else BailianAsrError
        ):
            transcriber._submit_task("oss://test-audio")
    finally:
        transcriber.close()
    assert states == ([True] if outcome == "timeout" else [True, False])
    assert len(requests) == (0 if outcome == "cancel_before_post" else 1)


def test_failure_before_submission_does_not_mark_a_paid_request(audio_path, mock_http):
    requests = mock_http(lambda _: httpx.Response(500, json={"code": "ServerError"}))
    states = []
    transcriber = BailianTranscriber(
        cloud_options(), API_KEY, on_submission_started=lambda: states.append(True)
    )
    try:
        with pytest.raises(BailianAsrError):
            transcriber.transcribe(audio_path, "asset-test")
    finally:
        transcriber.close()
    assert not states
    assert not any(request.url.path.endswith("/transcription") for request in requests)


def test_rejects_failed_subtask_even_when_parent_task_succeeded(
    audio_path: Path, mock_http
):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith(f"/tasks/{TASK_ID}"):
            return httpx.Response(
                200,
                json=completed_task(
                    subtask_status="FAILED", code="FILE_DOWNLOAD_FAILED"
                ),
            )
        return successful_handler(request)

    requests = mock_http(handler)
    transcriber = BailianTranscriber(cloud_options(), API_KEY, task_id=TASK_ID)
    try:
        with pytest.raises(BailianAsrError, match="无法读取音频") as error:
            transcriber.transcribe(audio_path, "asset-example")
    finally:
        transcriber.close()
    assert len(requests) == 1
    assert error.value.terminal_task is True


@pytest.mark.parametrize("task_status", ["FAILED", "CANCELED", "UNKNOWN"])
def test_marks_confirmed_cloud_failures_terminal(
    task_status: str, audio_path: Path, mock_http
):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"output": {"task_id": TASK_ID, "task_status": task_status}}
        )

    mock_http(handler)
    transcriber = BailianTranscriber(cloud_options(), API_KEY, task_id=TASK_ID)
    try:
        with pytest.raises(BailianAsrError) as error:
            transcriber.transcribe(audio_path, "asset-example")
    finally:
        transcriber.close()
    assert error.value.terminal_task is True


def test_keeps_task_resumable_after_query_network_error(audio_path: Path, mock_http):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("temporary network failure", request=request)

    mock_http(handler)
    transcriber = BailianTranscriber(cloud_options(), API_KEY, task_id=TASK_ID)
    try:
        with pytest.raises(BailianAsrError, match="继续查询") as error:
            transcriber.transcribe(audio_path, "asset-example")
    finally:
        transcriber.close()
    assert error.value.terminal_task is False


@pytest.mark.parametrize(
    "sentence",
    [
        {"begin_time": -100, "end_time": 1000, "text": "错误"},
        {"begin_time": 1000, "end_time": 500, "text": "错误"},
        {"begin_time": 1000, "end_time": 1000, "text": "错误"},
        {"begin_time": 100, "end_time": 5000, "text": "错误"},
        {"begin_time": "NaN", "end_time": 1000, "text": "错误"},
    ],
)
def test_rejects_invalid_sentence_timestamps(
    sentence: dict, audio_path: Path, mock_http
):
    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == RESULT_URL:
            return httpx.Response(
                200, json={"transcripts": [{"channel_id": 0, "sentences": [sentence]}]}
            )
        return successful_handler(request)

    mock_http(handler)
    transcriber = BailianTranscriber(cloud_options(), API_KEY, task_id=TASK_ID)
    try:
        with pytest.raises(BailianAsrError):
            transcriber.transcribe(audio_path, "asset-example")
    finally:
        transcriber.close()


@pytest.mark.parametrize(
    ("result", "message"),
    [
        ({"transcripts": []}, "未检测到可识别语音"),
        ({"transcripts": [{"channel_id": 0, "text": ""}]}, "未检测到可识别语音"),
        ({"transcripts": [{"channel_id": 0, "text": "有文字"}]}, "缺少句级时间戳"),
        ({"transcripts": [{"channel_id": 1}]}, "未请求的音轨"),
        ({"unexpected": True}, "不完整或格式异常"),
    ],
)
def test_explains_empty_or_malformed_recognition_results(
    result: dict, message: str, audio_path: Path, mock_http
):
    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == RESULT_URL:
            return httpx.Response(200, json=result)
        return successful_handler(request)

    mock_http(handler)
    transcriber = BailianTranscriber(cloud_options(), API_KEY, task_id=TASK_ID)
    try:
        with pytest.raises(BailianAsrError, match=message):
            transcriber.transcribe(audio_path, "asset-example")
    finally:
        transcriber.close()


def test_persists_task_id_before_honoring_post_submission_cancellation(
    audio_path: Path, mock_http
):
    requests = mock_http(successful_handler)
    submitted: list[str] = []

    class Cancelled(Exception):
        pass

    def check_cancellation() -> None:
        if submitted:
            raise Cancelled()

    transcriber = BailianTranscriber(
        cloud_options(),
        API_KEY,
        cancellation_check=check_cancellation,
        on_task_submitted=submitted.append,
    )
    try:
        with pytest.raises(Cancelled):
            transcriber.transcribe(audio_path, "asset-example")
    finally:
        transcriber.close()
    assert submitted == [TASK_ID]
    assert len(requests) == 3


def test_poll_timeout_preserves_existing_task_and_never_submits(
    audio_path: Path, mock_http, monkeypatch: pytest.MonkeyPatch
):
    requests = mock_http(successful_handler)
    monkeypatch.setattr(bailian_asr, "TASK_TIMEOUT_SECONDS", 0)
    transcriber = BailianTranscriber(cloud_options(), API_KEY, task_id=TASK_ID)
    try:
        with pytest.raises(BailianAsrError, match="已保留任务号"):
            transcriber.transcribe(audio_path, "asset-example")
    finally:
        transcriber.close()
    assert requests == []


@pytest.mark.parametrize(
    "base_url",
    [
        "http://dashscope.aliyuncs.com/api/v1",
        "https://example.com/api/v1",
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "https://dashscope.aliyuncs.com/api/v1?token=secret",
        "https://secret@dashscope.aliyuncs.com/api/v1",
    ],
)
def test_rejects_untrusted_api_urls_before_sending_key(base_url: str, mock_http):
    requests = mock_http(successful_handler)
    with pytest.raises(BailianAsrError, match="官方 HTTPS API 地址"):
        bailian_asr.test_bailian_connection(API_KEY, base_url)
    assert requests == []


def test_rejects_untrusted_result_url_without_following_it(audio_path: Path, mock_http):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith(f"/tasks/{TASK_ID}"):
            return httpx.Response(
                200,
                json=completed_task(transcription_url="https://example.com/secrets"),
            )
        raise AssertionError("Untrusted result URL must never be fetched")

    requests = mock_http(handler)
    transcriber = BailianTranscriber(cloud_options(), API_KEY, task_id=TASK_ID)
    try:
        with pytest.raises(BailianAsrError, match="无效的存储服务地址"):
            transcriber.transcribe(audio_path, "asset-example")
    finally:
        transcriber.close()
    assert len(requests) == 1


@pytest.mark.parametrize(
    "api_key", ["sk-中文私密", "sk-secret\nvalue", "sk-secret value", ""]
)
def test_rejects_malformed_keys_without_exposing_them(api_key: str, mock_http):
    requests = mock_http(successful_handler)
    with pytest.raises(BailianAsrError) as error:
        bailian_asr.test_bailian_connection(api_key)
    if api_key:
        assert api_key not in str(error.value)
    assert requests == []


def test_invalid_port_returns_safe_configuration_error(mock_http):
    requests = mock_http(successful_handler)
    with pytest.raises(BailianAsrError, match="地址格式异常"):
        bailian_asr.test_bailian_connection(
            API_KEY, "https://dashscope.aliyuncs.com:secret/api/v1"
        )
    assert requests == []
