from types import SimpleNamespace

import pytest

from openvideo.agent_service import AgentService
from openvideo.agent_tooling import CorrectTranscriptInput
from openvideo.core.identifiers import uuid7
from openvideo.core.transcription_models import Transcript, TranscriptSegment


@pytest.fixture
def transcript_scope(monkeypatch):
    transcript = Transcript(
        asset_id=str(uuid7()),
        segments=[
            TranscriptSegment(start_seconds=0, end_seconds=1, text="First subtitle"),
            TranscriptSegment(start_seconds=1, end_seconds=2, text="Second subtitle"),
        ],
    )
    captured = {}

    class CorrectorStub:
        def __init__(self, _model):
            pass

        async def correct_async(self, _transcript, segment_indices, instruction=None):
            captured.update(indices=segment_indices, instruction=instruction)
            return {index: "翻译后的字幕" for index in segment_indices}

        async def correct_chunked_async(self, *_args, **_kwargs):
            pytest.fail("不应使用分块模式")

        async def correct_with_compressed_context_async(self, *_args, **_kwargs):
            pytest.fail("不应使用压缩上下文模式")

    monkeypatch.setattr(
        "openvideo.agent_service.LiteLlmTranscriptCorrector", CorrectorStub
    )
    service = AgentService.__new__(AgentService)
    service.library = SimpleNamespace(
        load_agent_artifacts=lambda **_kwargs: [],
        load_transcript=lambda _asset_id: transcript,
    )
    context = SimpleNamespace(
        run=SimpleNamespace(run_id=f"run-{uuid7().hex}"),
        session=SimpleNamespace(asset_id=transcript.asset_id),
        task_input={"correction_instruction": "翻译成中文并保留专业术语"},
        model=None,
        cancellation=SimpleNamespace(raise_if_cancelled=lambda: None),
        create_artifact=lambda *_args: SimpleNamespace(model_dump=lambda **_kwargs: {}),
    )
    return service, context, captured


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "task_scope, tool_scope, expected_scope",
    [
        ({"segment_indices": [0]}, [1], [0]),
        ({"segment_indices": None}, [1], [0, 1]),
        ({"segment_indices": [1, 0, 1]}, None, [1, 0]),
        ({}, [1], [1]),
    ],
)
async def test_user_scope_and_target_language_override_model_arguments(
    transcript_scope, task_scope, tool_scope, expected_scope
):
    service, context, captured = transcript_scope
    context.task_input.update(task_scope)
    result = await service._correct_transcript(
        context,
        CorrectTranscriptInput(segment_indices=tool_scope, instruction="翻译成法语"),
    )
    assert result["ok"] is True
    assert captured == {
        "indices": expected_scope,
        "instruction": "翻译成中文并保留专业术语",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "invalid_scope", ["all", [True], ["1"], [1.5], {}, [], [-1], [2]]
)
async def test_invalid_explicit_scope_cannot_fall_back_to_all_subtitles(
    transcript_scope, invalid_scope
):
    service, context, captured = transcript_scope
    context.task_input["segment_indices"] = invalid_scope
    result = await service._correct_transcript(context, CorrectTranscriptInput())
    assert result == {"ok": False, "error": "字幕片段范围无效"}
    assert captured == {}
