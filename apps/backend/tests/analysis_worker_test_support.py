"""领域测试显式注入进程协议替身，真实进程生命周期由独立回归覆盖。"""

import asyncio
from threading import Event

from openvideo.analysis_worker import (
    TimelineRequest,
    execute_worker_request,
    prepare_worker_transcriber,
)
from openvideo.tools.ocr import LocalOcrReader


class InlineAnalysisWorker:
    def __init__(self):
        self._reader = LocalOcrReader()

    async def execute(self, request, cancel_event, on_progress):
        result = await asyncio.to_thread(
            execute_worker_request, request, cancel_event, on_progress, self._reader
        )
        if isinstance(request, TimelineRequest):
            for segment in result:
                for path in segment.key_frame_paths:
                    frame = request.artifacts_directory / path
                    if not frame.exists():
                        frame.parent.mkdir(parents=True, exist_ok=True)
                        frame.write_bytes(b"test-frame")
        return result

    async def close(self):
        return None


def prepare_transcriber(manager, job, options, asset):
    request = manager._transcription_request(
        job,
        options,
        asset,
        manager.library.resolve_asset_file(asset, asset.playback_path),
        manager.library.temporary_directory(job.job_id),
    )
    return prepare_worker_transcriber(
        request, Event(), lambda progress: manager._worker_progress(job, progress)
    )
