"""视频分析领域模型。

音频转写、内容重要性、关键帧与画面描述共享这些结构。独立于 models.py，
避免与下载/媒体清单的模型耦合，也让分析功能可以单独演进。
"""

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class AnalysisStage(StrEnum):
    PENDING = "pending"
    EXTRACTING_AUDIO = "extracting_audio"
    TRANSCRIBING = "transcribing"
    COMPLETE = "complete"
    FAILED = "failed"


TERMINAL_ANALYSIS_STAGES = {AnalysisStage.COMPLETE, AnalysisStage.FAILED}


class TranscriptSegment(BaseModel):
    """一句带起止时间的转写文本，是后续内容重要性与画面分析的最小单元。"""

    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(ge=0)
    text: str


class Transcript(BaseModel):
    asset_id: str
    language: str | None = None
    segments: list[TranscriptSegment] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class AnalysisJob(BaseModel):
    job_id: str
    asset_id: str
    stage: AnalysisStage = AnalysisStage.PENDING
    progress_percent: float = 0
    message: str = "等待开始"
    error_message: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
