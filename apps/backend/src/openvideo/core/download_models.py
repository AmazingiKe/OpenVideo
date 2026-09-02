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


class DownloadQuality(StrEnum):
    BEST = "best"
    UHD_2160 = "2160p"
    QHD_1440 = "1440p"
    FULL_HD_1080 = "1080p"
    HD_720 = "720p"
    SD_480 = "480p"


TERMINAL_DOWNLOAD_STAGES = {DownloadStage.COMPLETE, DownloadStage.FAILED}


class DownloadJob(BaseModel):
    job_id: str
    asset_id: str
    video_quality: DownloadQuality = DownloadQuality.BEST
    stage: DownloadStage = DownloadStage.PENDING
    progress_percent: float = 0
    message: str = "等待开始"
    error_message: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class DownloadTask(DownloadJob):
    """下载任务附带素材标题，供后台状态通知识别对应内容。"""

    name: str
