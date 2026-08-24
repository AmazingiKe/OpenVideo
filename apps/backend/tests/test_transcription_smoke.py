import os
from pathlib import Path

import pytest

from openvideo.core.transcription_models import (
    TRANSCRIPTION_MODEL_CATALOG,
    TranscriptionEngine,
    TranscriptionIntegrationStatus,
    TranscriptionOptions,
)
from openvideo.tools.transcribe import create_transcriber


RUN_SMOKE_TESTS = os.getenv("OPENVIDEO_RUN_ASR_SMOKE_TESTS") == "1"
SMOKE_WAV_PATH = os.getenv("OPENVIDEO_ASR_SMOKE_WAV")
SMOKE_MODELS_DIRECTORY = os.getenv("OPENVIDEO_MODELS_DIRECTORY")


def _smoke_options() -> list[TranscriptionOptions]:
    options: list[TranscriptionOptions] = []
    for descriptor in TRANSCRIPTION_MODEL_CATALOG:
        if descriptor.integration_status != TranscriptionIntegrationStatus.AVAILABLE:
            continue
        if descriptor.engine == TranscriptionEngine.QWEN3_ASR:
            device = "cuda"
            compute_type = "float16"
        elif descriptor.engine == TranscriptionEngine.SENSEVOICE:
            device = "auto"
            compute_type = "auto"
        else:
            device = "cpu"
            compute_type = "int8"
        options.append(
            TranscriptionOptions(
                engine=descriptor.engine,
                model=descriptor.model,
                language="zh",
                device=device,
                compute_type=compute_type,
            )
        )
    return options


SMOKE_OPTIONS = _smoke_options()


@pytest.mark.smoke
@pytest.mark.skipif(
    not RUN_SMOKE_TESTS or not SMOKE_WAV_PATH or not SMOKE_MODELS_DIRECTORY,
    reason="需要显式启用本地 ASR 模型冒烟测试并提供模型目录与中文 WAV",
)
@pytest.mark.parametrize(
    "options",
    SMOKE_OPTIONS,
    ids=[f"{options.engine.value}-{options.model}" for options in SMOKE_OPTIONS],
)
def test_local_model_transcribes_chinese_wav(options: TranscriptionOptions):
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
