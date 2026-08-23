from openvideo.core.analysis_models import Transcript, TranscriptSegment
from openvideo.tools import transcript_correction
from openvideo.tools.transcript_correction import OpenAiCompatibleTranscriptCorrector


ASSET_ID = "asset-0198d12345677890abcdef1234567890"


class StubResponse:
    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return {
            "choices": [
                {
                    "message": {
                        "content": '{"segments":[{"index":1,"text":"正确术语"}]}'
                    }
                }
            ]
        }


def test_selected_correction_includes_neighboring_context(monkeypatch):
    captured_payload: dict = {}

    def post(url, *, headers, json, timeout):
        captured_payload.update(json)
        return StubResponse()

    monkeypatch.setattr(transcript_correction.httpx, "post", post)
    transcript = Transcript(
        asset_id=ASSET_ID,
        segments=[
            TranscriptSegment(start_seconds=0, end_seconds=1, text="前文"),
            TranscriptSegment(start_seconds=1, end_seconds=2, text="错误术语"),
            TranscriptSegment(start_seconds=2, end_seconds=3, text="后文"),
        ],
    )
    corrector = OpenAiCompatibleTranscriptCorrector(
        base_url="https://example.com/v1",
        api_key="test-key",
        model="test-model",
    )

    corrections = corrector.correct(transcript, [1])

    assert corrections == {1: "正确术语"}
    prompt = captured_payload["messages"][0]["content"]
    assert "[上下文 0] 前文" in prompt
    assert "[目标 1] 错误术语" in prompt
    assert "[上下文 2] 后文" in prompt
