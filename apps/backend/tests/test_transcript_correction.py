from types import SimpleNamespace

from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.analysis_models import Transcript, TranscriptSegment
from openvideo.tools import llm
from openvideo.tools.transcript_correction import LiteLlmTranscriptCorrector


ASSET_ID = "asset-0198d12345677890abcdef1234567890"


def test_selected_correction_includes_neighboring_context(monkeypatch):
    captured_payload: dict = {}

    def completion(**kwargs):
        captured_payload.update(kwargs)
        message = SimpleNamespace(
            content='{"segments":[{"index":1,"text":"正确术语"}]}'
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
    corrector = LiteLlmTranscriptCorrector(
        AiModelConfiguration(
            model_id="model-01890f4c7a2b7cc298c4dc0c0c07398f",
            name="文本模型",
            litellm_model="openai/test-model",
            api_base="https://example.com/v1",
            api_key="test-key",
        )
    )

    corrections = corrector.correct(transcript, [1])

    assert corrections == {1: "正确术语"}
    prompt = captured_payload["messages"][0]["content"]
    assert "[上下文 0] 前文" in prompt
    assert "[目标 1] 错误术语" in prompt
    assert "[上下文 2] 后文" in prompt
