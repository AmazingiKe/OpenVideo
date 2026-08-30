"""媒体资源、元数据、时间轴片段与用户标记的数据契约。"""

from datetime import UTC, datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator

from openvideo.core.transcription_models import TranscriptionStatus


MarkerImportance = Literal[0, 1, 2, 3, 4, 5]


class SourcePlatform(StrEnum):
    BILIBILI = "bilibili"
    DOUYIN = "douyin"
    LOCAL = "local"
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


class MediaAsset(BaseModel):
    asset_id: str
    folder_id: str | None = None
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
    folder_id: str | None
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
    scrub_preview_url: str | None
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


class AssetStoryboardMetadata(BaseModel):
    sprite_path: str
    tile_width: int
    tile_height: int
    interval_seconds: float
    columns: int
    total_tiles: int


class AssetTranscriptionMetadata(BaseModel):
    """资源清单只保留任务摘要，详细参数与错误仍由转录产物独立记录。"""

    status: TranscriptionStatus = TranscriptionStatus.NOT_STARTED
    attempt_count: int = Field(default=0, ge=0)


class AssetMetadata(BaseModel):
    asset_id: str
    folder_id: str | None = None
    media_type: MediaType
    title: str
    source: AssetSourceMetadata
    video: VideoMetadata | None = None
    transcription: AssetTranscriptionMetadata = Field(
        default_factory=AssetTranscriptionMetadata
    )
    status: MediaAssetStatus
    error_message: str | None = None
    playback_path: str | None = None
    thumbnail_path: str | None = None
    remote_thumbnail_url: HttpUrl | None = None
    storyboard: AssetStoryboardMetadata | None = None
    created_at: datetime
    updated_at: datetime


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
    formula_latex: list[str] = Field(default_factory=list)
    marker_ids: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)


class MediaMarker(BaseModel):
    """标记只表达时间边界与用户重要程度，避免混入分析策略配置。"""

    model_config = ConfigDict(extra="forbid")

    marker_id: str
    asset_id: str
    start_seconds: float = Field(ge=0)
    end_seconds: float | None = Field(default=None, ge=0)
    importance: MarkerImportance = 0

    @model_validator(mode="after")
    def validate_range(self) -> "MediaMarker":
        if self.end_seconds is not None and self.end_seconds <= self.start_seconds:
            raise ValueError("范围标记的结束时间必须晚于开始时间")
        return self
