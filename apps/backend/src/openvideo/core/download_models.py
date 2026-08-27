"""媒体下载任务及其生命周期状态。"""

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field

from openvideo.core.identifiers import uuid7


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


class DownloadEvent(BaseModel):
    """下载事件保留阶段语义变化，避免高频进度采样淹没可诊断信息。"""

    event_id: str
    job_id: str
    stage: DownloadStage
    progress_percent: float
    message: str
    error_message: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @classmethod
    def capture(
        cls,
        job: DownloadJob,
        *,
        message: str | None = None,
    ) -> "DownloadEvent":
        """为一次有意义的状态变化生成可独立持久化的不可变快照。"""

        return cls(
            event_id=f"event-{uuid7().hex}",
            job_id=job.job_id,
            stage=job.stage,
            progress_percent=job.progress_percent,
            message=message if message is not None else job.message,
            error_message=job.error_message,
        )


class DownloadTask(DownloadJob):
    """下载任务聚合素材标题与历史事件，供任务列表恢复和诊断使用。"""

    name: str
    events: list[DownloadEvent] = Field(default_factory=list)
