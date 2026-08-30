"""惰性视觉检索索引的状态与命中契约。"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class VisualIndexState(StrEnum):
    NOT_PREPARED = "not_prepared"
    DOWNLOADING = "downloading"
    LOADING = "loading"
    INDEXING = "indexing"
    READY = "ready"
    ERROR = "error"


TERMINAL_VISUAL_INDEX_STATES = {
    VisualIndexState.READY,
    VisualIndexState.ERROR,
}


class VisualIndexStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")

    state: VisualIndexState = VisualIndexState.NOT_PREPARED
    progress_percent: float = Field(default=0, ge=0, le=100)
    message: str = "视觉索引尚未准备"
    model_name: str
    model_revision: str
    indexed_frames: int = Field(default=0, ge=0)
    total_frames: int = Field(default=0, ge=0)
    model_loaded: bool = False
    error_message: str | None = None
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class VisualIndexPrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    asset_id: str | None = None


class VisualFrameMatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    asset_id: str
    relative_path: str
    seconds: float = Field(ge=0)
    similarity: float = Field(ge=-1, le=1)
