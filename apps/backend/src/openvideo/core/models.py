from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field, HttpUrl

from openvideo.core.analysis_models import TranscriptionStatus


class SourcePlatform(StrEnum):
    BILIBILI = "bilibili"
    DOUYIN = "douyin"
    YOUTUBE = "youtube"


class MediaAssetStatus(StrEnum):
    PENDING = "pending"
    DOWNLOADING = "downloading"
    PROCESSING = "processing"
    READY = "ready"
    FAILED = "failed"


class MediaType(StrEnum):
    VIDEO = "video"
    IMAGE = "image"


class DownloadStage(StrEnum):
    PENDING = "pending"
    READING_METADATA = "reading_metadata"
    DOWNLOADING = "downloading"
    PROCESSING = "processing"
    COMPLETE = "complete"
    FAILED = "failed"


TERMINAL_DOWNLOAD_STAGES = {DownloadStage.COMPLETE, DownloadStage.FAILED}


class MediaAsset(BaseModel):
    asset_id: str
    media_type: MediaType = MediaType.VIDEO
    source_url: str
    source_platform: SourcePlatform
    source_video_id: str | None = None
    title: str = "等待读取视频信息"
    author_name: str | None = None
    description: str | None = None
    duration_seconds: float | None = None
    width: int | None = None
    height: int | None = None
    video_codec: str | None = None
    audio_codec: str | None = None
    playback_path: str | None = None
    thumbnail_path: str | None = None
    remote_thumbnail_url: HttpUrl | None = None
    thumbnail_sprite_path: str | None = None
    thumbnail_tile_width: int | None = None
    thumbnail_tile_height: int | None = None
    thumbnail_interval_seconds: float | None = None
    thumbnail_columns: int | None = None
    thumbnail_total_tiles: int | None = None
    status: MediaAssetStatus = MediaAssetStatus.PENDING
    error_message: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class ThumbnailStoryboardTile(BaseModel):
    start_time: float
    x: int
    y: int


class ThumbnailStoryboardResponse(BaseModel):
    url: str
    tile_width: int
    tile_height: int
    tiles: list[ThumbnailStoryboardTile]


class MediaAssetResponse(BaseModel):
    asset_id: str
    media_type: MediaType
    source_url: str
    source_platform: SourcePlatform
    source_video_id: str | None
    title: str
    author_name: str | None
    description: str | None
    duration_seconds: float | None
    width: int | None
    height: int | None
    video_codec: str | None
    audio_codec: str | None
    status: MediaAssetStatus
    error_message: str | None
    playback_url: str | None
    thumbnail_url: str | None
    thumbnail_storyboard: ThumbnailStoryboardResponse | None = None
    created_at: datetime
    updated_at: datetime


class AssetSourceMetadata(BaseModel):
    url: str
    platform: SourcePlatform
    source_id: str | None = None
    author_name: str | None = None
    description: str | None = None


class VideoMetadata(BaseModel):
    duration_seconds: float | None = None
    width: int | None = None
    height: int | None = None
    video_codec: str | None = None
    audio_codec: str | None = None


class AssetTranscriptionMetadata(BaseModel):
    """资源清单只保留任务摘要，详细参数与错误仍由转录产物独立记录。"""

    status: TranscriptionStatus = TranscriptionStatus.NOT_STARTED
    attempt_count: int = Field(default=0, ge=0)


class AssetMetadata(BaseModel):
    asset_id: str
    media_type: MediaType
    title: str
    source: AssetSourceMetadata
    video: VideoMetadata | None = None
    transcription: AssetTranscriptionMetadata = Field(
        default_factory=AssetTranscriptionMetadata
    )
    created_at: datetime
    updated_at: datetime


class DownloadJob(BaseModel):
    job_id: str
    asset_id: str
    stage: DownloadStage = DownloadStage.PENDING
    progress_percent: float = 0
    message: str = "等待开始"
    error_message: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class MediaSegment(BaseModel):
    segment_id: str
    asset_id: str
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(gt=0)
    title: str = "时间轴事件"
    detailed_summary: str | None = None
    transcript_text: str | None = None
    speaker_name: str | None = None
    key_frame_paths: list[str] = Field(default_factory=list)
    visual_description: str | None = None
    ocr_text: str | None = None
    marker_ids: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)


class MediaMarker(BaseModel):
    """手工标记将用户关注的时间点与媒体资产一同保存，供不同界面复用。"""

    marker_id: str
    asset_id: str
    time_seconds: float = Field(ge=0)
    tags: list[str] = Field(default_factory=list)
