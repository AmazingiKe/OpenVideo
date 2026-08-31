from types import SimpleNamespace

import pytest
from litellm.exceptions import ContextWindowExceededError

from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.transcription_models import Transcript, TranscriptSegment
from openvideo.tools import llm
from openvideo.tools.transcript_correction import (
    LiteLlmTranscriptCorrector,
    TranscriptCorrectionContextLengthError,
    TranscriptCorrectionError,
)


ASSET_ID = "asset-0198d12345677890abcdef1234567890"


def create_corrector() -> LiteLlmTranscriptCorrector:
    return LiteLlmTranscriptCorrector(
        AiModelConfiguration(
            model_id="model-01890f4c7a2b7cc298c4dc0c0c07398f",
            name="文本模型",
            litellm_model="openai/test-model",
            api_base="https://example.com/v1",
            api_key="test-key",
        )
    )


def test_normal_correction_sends_complete_transcript_once(monkeypatch):
    requests: list[dict[str, object]] = []

    def completion(**kwargs):
        requests.append(kwargs)
        message = SimpleNamespace(
            content='{"corrections":[{"index":1,"text":"正确术语"}]}'
        )
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    monkeypatch.setattr(llm.litellm, "completion", completion)
    transcript = Transcript(
        asset_id=ASSET_ID,
        segments=[
            TranscriptSegment(start_seconds=0, end_seconds=1, text="前文"),
            TranscriptSegment(start_seconds=1, end_seconds=2, text="错误术语"),
            TranscriptSegment(start_seconds=2, end_seconds=3, text="后文"),
        ],
    )

    corrections = create_corrector().correct(transcript, [1])

    assert corrections == {1: "正确术语"}
    assert len(requests) == 1
    prompt = requests[0]["messages"][0]["content"]
    assert "[上下文 0] 前文" in prompt
    assert "[目标 1] 错误术语" in prompt
    assert "[上下文 2] 后文" in prompt
    assert requests[0]["max_tokens"] == 16_384
    assert requests[0]["thinking"] == {"type": "disabled"}


def test_custom_instruction_can_translate_with_full_transcript_context(monkeypatch):
    requests: list[dict[str, object]] = []

    def completion(**kwargs):
        requests.append(kwargs)
        message = SimpleNamespace(
            content='{"corrections":[{"index":0,"text":"专业术语"}]}'
        )
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    monkeypatch.setattr(llm.litellm, "completion", completion)
    transcript = Transcript(
        asset_id=ASSET_ID,
        segments=[
            TranscriptSegment(start_seconds=0, end_seconds=1, text="technical term"),
            TranscriptSegment(start_seconds=1, end_seconds=2, text="topic context"),
        ],
    )

    corrections = create_corrector().correct(
        transcript,
        [0],
        "将英文翻译成中文，结合整段视频主题统一专业词汇。",
    )

    assert corrections == {0: "专业术语"}
    prompt = requests[0]["messages"][0]["content"]
    assert "将英文翻译成中文，结合整段视频主题统一专业词汇。" in prompt
    assert "[目标 0] technical term" in prompt
    assert "[上下文 1] topic context" in prompt
    assert "不得总结、翻译" not in prompt


def test_empty_result_does_not_require_unchanged_segments(monkeypatch):
    monkeypatch.setattr(
        llm.litellm,
        "completion",
        lambda **_: SimpleNamespace(
            choices=[
                SimpleNamespace(message=SimpleNamespace(content='{"corrections":[]}'))
            ]
        ),
    )
    transcript = Transcript(
        asset_id=ASSET_ID,
        segments=[TranscriptSegment(start_seconds=0, end_seconds=1, text="正确原文")],
    )

    assert create_corrector().correct(transcript, [0]) == {}


def test_context_limit_preserves_recoverable_error_type(monkeypatch):
    def completion(**_):
        raise ContextWindowExceededError(
            "too long",
            model="test-model",
            llm_provider="openai",
        )

    monkeypatch.setattr(llm.litellm, "completion", completion)
    transcript = Transcript(
        asset_id=ASSET_ID,
        segments=[TranscriptSegment(start_seconds=0, end_seconds=1, text="原文")],
    )

    with pytest.raises(TranscriptCorrectionContextLengthError):
        create_corrector().correct(transcript, [0])


def test_format_repair_does_not_resend_transcript(monkeypatch):
    messages_by_request: list[list[dict[str, object]]] = []
    responses = iter(
        [
            "不是 JSON",
            '{"corrections":[{"index":0,"text":"修正文字"}]}',
        ]
    )

    def completion(**kwargs):
        messages_by_request.append(kwargs["messages"])
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=next(responses)))]
        )

    monkeypatch.setattr(llm.litellm, "completion", completion)
    transcript = Transcript(
        asset_id=ASSET_ID,
        segments=[TranscriptSegment(start_seconds=0, end_seconds=1, text="唯一原文")],
    )

    assert create_corrector().correct(transcript, [0]) == {0: "修正文字"}
    assert len(messages_by_request) == 2
    assert "唯一原文" in messages_by_request[0][0]["content"]
    assert "唯一原文" not in str(messages_by_request[1])
    assert messages_by_request[1][0]["content"] == "不是 JSON"


@pytest.mark.parametrize(
    "content",
    [
        '{"corrections":[{"index":2,"text":"越界"}]}',
        '{"corrections":[{"index":0,"text":""}]}',
        '{"corrections":[{"index":0,"text":"甲"},{"index":0,"text":"乙"}]}',
    ],
)
def test_invalid_corrections_are_rejected_after_one_repair(monkeypatch, content):
    monkeypatch.setattr(
        llm.litellm,
        "completion",
        lambda **_: SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
        ),
    )
    transcript = Transcript(
        asset_id=ASSET_ID,
        segments=[TranscriptSegment(start_seconds=0, end_seconds=1, text="原文")],
    )

    with pytest.raises(TranscriptCorrectionError):
        create_corrector().correct(transcript, [0])
