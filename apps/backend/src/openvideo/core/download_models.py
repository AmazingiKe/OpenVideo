"""媒体下载任务及其生命周期状态。"""

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class DownloadStage(StrEnum):
    PENDING = "pending"
    READING_METADATA = "reading_metadata"
    DOWNLOADING = "downloading"
    PROCESSING = "processing"
    COMPLETE = "complete"
    FAILED = "failed"


TERMINAL_DOWNLOAD_STAGES = {DownloadStage.COMPLETE, DownloadStage.FAILED}


class DownloadJob(BaseModel):
    job_id: str
    asset_id: str
    stage: DownloadStage = DownloadStage.PENDING
    progress_percent: float = 0
    message: str = "等待开始"
    error_message: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
