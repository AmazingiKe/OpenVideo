import os
from pathlib import Path

import pytest

from openvideo.core.analysis_models import TranscriptionOptions
from openvideo.tools.transcribe import create_transcriber


RUN_SMOKE_TESTS = os.getenv("OPENVIDEO_RUN_ASR_SMOKE_TESTS") == "1"
SMOKE_WAV_PATH = os.getenv("OPENVIDEO_ASR_SMOKE_WAV")
SMOKE_MODELS_DIRECTORY = os.getenv("OPENVIDEO_MODELS_DIRECTORY")


@pytest.mark.smoke
@pytest.mark.skipif(
    not RUN_SMOKE_TESTS or not SMOKE_WAV_PATH or not SMOKE_MODELS_DIRECTORY,
    reason="需要显式启用本地 ASR 模型烟雾测试并提供模型目录与短中文 WAV",
)
@pytest.mark.parametrize(
    "options",
    [
        TranscriptionOptions(
            engine="qwen3-asr",
            model="qwen3-asr-1.7b",
            language="zh",
            device="cuda",
            compute_type="float16",
        ),
        TranscriptionOptions(
            engine="sensevoice",
            model="sensevoice-small",
            language="zh",
            device="auto",
            compute_type="auto",
        ),
    ],
)
def test_local_model_transcribes_short_chinese_wav(options: TranscriptionOptions):
    transcriber = create_transcriber(options, Path(SMOKE_MODELS_DIRECTORY))
    try:
        transcript = transcriber.transcribe(Path(SMOKE_WAV_PATH), "smoke-asset")
    finally:
        transcriber.close()

    assert transcript.segments
    assert all(segment.text.strip() for segment in transcript.segments)
    assert all(
        segment.end_seconds > segment.start_seconds
        for segment in transcript.segments
    )
