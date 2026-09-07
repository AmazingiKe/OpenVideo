"""媒体资源、元数据、时间轴片段与用户标记的数据契约。"""

from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    HttpUrl,
    StringConstraints,
    model_validator,
)

from openvideo.core.transcription_models import TranscriptionStatus


MarkerImportance = Literal[0, 1, 2, 3, 4, 5]
MarkerContent = Annotated[str, StringConstraints(strip_whitespace=True)]
MINIMUM_MARKER_IMPORTANCE: MarkerImportance = 1
MAXIMUM_MARKER_IMPORTANCE = 5


def effective_marker_importance(
    content: str, importance: MarkerImportance
) -> MarkerImportance:
    """只有完全空白的标记才按最低星级兜底，文字注释不隐式附加评分。"""
    return importance or (0 if content.strip() else MINIMUM_MARKER_IMPORTANCE)


def marker_annotation_context(
    content: str, importance: MarkerImportance
) -> dict[str, str | int]:
    """把用户注释与有效评分组合成上下文，省略未填写的项。"""
    annotation: dict[str, str | int] = {}
    normalized_content = content.strip()
    if normalized_content:
        annotation["content"] = normalized_content
    effective_importance = effective_marker_importance(content, importance)
    if effective_importance:
        annotation["importance"] = effective_importance
    return annotation


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


class SubtitleFontSize(StrEnum):
    SMALL = "small"
    MEDIUM = "medium"
    LARGE = "large"


class SubtitlePosition(StrEnum):
    BOTTOM = "bottom"
    RAISED = "raised"
    CENTER = "center"


class SubtitleBackground(StrEnum):
    NONE = "none"
    SHADOW = "shadow"
    SOLID = "solid"


class SubtitleDisplaySettings(BaseModel):
    """单视频字幕显示状态独立保存，偏移不修改原始转写时间。"""

    model_config = ConfigDict(extra="forbid")

    font_size: SubtitleFontSize = SubtitleFontSize.MEDIUM
    position: SubtitlePosition = SubtitlePosition.BOTTOM
    background: SubtitleBackground = SubtitleBackground.SHADOW
    offset_milliseconds: int = Field(default=0, ge=-600_000, le=600_000)


class VideoConfiguration(BaseModel):
    """单素材交互设置需要随视频迁移，不能落入设备级应用配置。"""

    model_config = ConfigDict(extra="forbid")

    format_version: int = 1
    asset_id: str
    subtitle_display: SubtitleDisplaySettings = Field(
        default_factory=SubtitleDisplaySettings
    )


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
    thumbnail_storyboard_manifest_path: str | None = None
    status: MediaAssetStatus = MediaAssetStatus.PENDING
    error_message: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class ThumbnailStoryboardPageResponse(BaseModel):
    url: str
    start_index: int
    tile_count: int


class ThumbnailStoryboardResponse(BaseModel):
    storyboard_id: str
    tile_width: int
    tile_height: int
    interval_seconds: float
    columns: int
    total_tiles: int
    pages: list[ThumbnailStoryboardPageResponse]


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
    thumbnail_url: str | None
    thumbnail_storyboard: ThumbnailStoryboardResponse | None = None
    subtitle_display: SubtitleDisplaySettings = Field(
        default_factory=SubtitleDisplaySettings
    )
    created_at: datetime
    updated_at: datetime


class SubtitleExportResult(BaseModel):
    export_id: str
    relative_path: str
    file_name: str
    size_bytes: int
    exported_at: datetime


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
    thumbnail_storyboard_manifest_path: str | None = None
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
    """时间位置承载用户注释与可选评分，供编辑和视频理解共享。"""

    model_config = ConfigDict(extra="forbid")

    marker_id: str
    asset_id: str
    start_seconds: float = Field(ge=0)
    end_seconds: float | None = Field(default=None, ge=0)
    content: MarkerContent = ""
    importance: MarkerImportance = 0

    def context_payload(self) -> dict[str, str | float | int | None]:
        """上下文采用有效评分，持久化仍保留用户未评分的原始状态。"""
        return {
            "marker_id": self.marker_id,
            "asset_id": self.asset_id,
            "start_seconds": self.start_seconds,
            "end_seconds": self.end_seconds,
            **marker_annotation_context(self.content, self.importance),
        }

    @model_validator(mode="after")
    def validate_range(self) -> "MediaMarker":
        if self.end_seconds is not None and self.end_seconds <= self.start_seconds:
            raise ValueError("范围标记的结束时间必须晚于开始时间")
        return self
