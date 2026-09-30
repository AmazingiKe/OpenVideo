from __future__ import annotations

import pytest
from litellm import ModelResponse
from pydantic import ValidationError

from openvideo.agent_tooling import CorrectTranscriptInput
from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.identifiers import uuid7
from openvideo.core.transcription_models import Transcript, TranscriptSegment
from openvideo.tools import llm
from openvideo.tools.transcript_correction import (
    LiteLlmTranscriptCorrector,
    TranscriptCorrectionContextLengthError,
    TranscriptCorrectionError,
)


def subtitle_sample() -> Transcript:
    return Transcript(
        asset_id=str(uuid7()),
        segments=[
            TranscriptSegment(start_seconds=0, end_seconds=1, text="first sentence"),
            TranscriptSegment(start_seconds=1, end_seconds=2, text="second sentence"),
        ],
    )


@pytest.mark.parametrize("invalid_index", [True, False, 1.0, "1"])
def test_tool_input_does_not_coerce_non_integer_subtitle_indices(invalid_index):
    with pytest.raises(ValidationError):
        CorrectTranscriptInput(segment_indices=[invalid_index])


@pytest.mark.asyncio
@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.parametrize("finish_reason", ["length", "max_tokens"])
@pytest.mark.parametrize("repairing_format", [False, True])
async def test_truncated_valid_json_is_not_delivered_as_completed_translation(
    monkeypatch, asynchronous, finish_reason, repairing_format
):
    request_count = 0
    response = ModelResponse(
        choices=[
            {
                "finish_reason": finish_reason,
                "message": {
                    "role": "assistant",
                    "content": '{"corrections":[{"index":0,"text":"第一句"}]}',
                },
            }
        ]
    )

    def complete(**_request):
        nonlocal request_count
        request_count += 1
        if repairing_format and request_count == 1:
            return ModelResponse(
                choices=[
                    {
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": "错误格式"},
                    }
                ]
            )
        return response

    async def complete_async(**request):
        return complete(**request)

    monkeypatch.setattr(llm.litellm, "completion", complete)
    monkeypatch.setattr(llm.litellm, "acompletion", complete_async)
    corrector = LiteLlmTranscriptCorrector(
        AiModelConfiguration(name="测试翻译模型", litellm_model="openai/dummy-model")
    )
    with pytest.raises(TranscriptCorrectionContextLengthError, match="截断"):
        if asynchronous:
            await corrector.correct_async(subtitle_sample(), [0, 1], "翻译成中文")
        else:
            corrector.correct(subtitle_sample(), [0, 1], "翻译成中文")
    assert request_count == (2 if repairing_format else 1)


@pytest.mark.asyncio
@pytest.mark.parametrize("asynchronous", [False, True])
async def test_normal_completed_translation_keeps_integer_indices(
    monkeypatch, asynchronous
):
    response = ModelResponse(
        choices=[
            {
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": '{"corrections":[{"index":0,"text":"第一句"},{"index":1,"text":"第二句"}]}',
                },
            }
        ]
    )
    monkeypatch.setattr(llm.litellm, "completion", lambda **_request: response)

    async def complete_async(**_request):
        return response

    monkeypatch.setattr(llm.litellm, "acompletion", complete_async)
    corrector = LiteLlmTranscriptCorrector(
        AiModelConfiguration(name="测试模型", litellm_model="openai/dummy-model")
    )
    result = (
        await corrector.correct_async(subtitle_sample(), [0, 1], "翻译成中文")
        if asynchronous
        else corrector.correct(subtitle_sample(), [0, 1], "翻译成中文")
    )
    assert result == {0: "第一句", 1: "第二句"}
    assert all(type(index) is int for index in result)


@pytest.mark.asyncio
@pytest.mark.parametrize("asynchronous", [False, True])
async def test_filtered_content_is_not_reported_as_completed_text(
    monkeypatch, asynchronous
):
    response = ModelResponse(
        choices=[
            {
                "finish_reason": "content_filter",
                "message": {"role": "assistant", "content": "部分内容"},
            }
        ]
    )
    monkeypatch.setattr(llm.litellm, "completion", lambda **_request: response)

    async def complete_async(**_request):
        return response

    monkeypatch.setattr(llm.litellm, "acompletion", complete_async)
    model = AiModelConfiguration(name="测试模型", litellm_model="openai/dummy-model")
    with pytest.raises(llm.LlmCompletionError, match="未完成"):
        if asynchronous:
            await llm.complete_text_async(model, [], 1)
        else:
            llm.complete_text(model, [], 1)


@pytest.mark.asyncio
@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.parametrize("invalid_index", ["true", "false"])
async def test_boolean_subtitle_index_is_rejected_even_after_format_repair(
    monkeypatch, asynchronous, invalid_index
):
    request_count = 0
    response = ModelResponse(
        choices=[
            {
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": '{"corrections":[{"index":'
                    + invalid_index
                    + ',"text":"不应写入"}]}',
                },
            }
        ]
    )

    def complete(**_request):
        nonlocal request_count
        request_count += 1
        return response

    async def complete_async(**request):
        return complete(**request)

    monkeypatch.setattr(llm.litellm, "completion", complete)
    monkeypatch.setattr(llm.litellm, "acompletion", complete_async)
    corrector = LiteLlmTranscriptCorrector(
        AiModelConfiguration(name="测试模型", litellm_model="openai/dummy-model")
    )
    with pytest.raises(TranscriptCorrectionError, match="无法应用"):
        if asynchronous:
            await corrector.correct_async(subtitle_sample(), [0, 1])
        else:
            corrector.correct(subtitle_sample(), [0, 1])
    assert request_count == 2
