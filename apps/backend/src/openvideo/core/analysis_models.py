"""视频分析领域模型。

音频转写、内容重要性、关键帧与画面描述共享这些结构。独立于 models.py，
避免与下载/媒体清单的模型耦合，也让分析功能可以单独演进。
"""

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field, model_validator


class AnalysisStage(StrEnum):
    PENDING = "pending"
    EXTRACTING_AUDIO = "extracting_audio"
    TRANSCRIBING = "transcribing"
    BUILDING_TIMELINE = "building_timeline"
    EXTRACTING_FRAMES = "extracting_frames"
    DESCRIBING_VISUALS = "describing_visuals"
    COMPLETE = "complete"
    FAILED = "failed"


TERMINAL_ANALYSIS_STAGES = {AnalysisStage.COMPLETE, AnalysisStage.FAILED}


class AnalysisMode(StrEnum):
    FULL = "full"
    MARKERS = "markers"


class AnalysisOperation(StrEnum):
    TRANSCRIPTION = "transcription"
    ANALYSIS = "analysis"


class AnalysisCapability(StrEnum):
    TRANSCRIPT = "transcript"
    TIMELINE = "timeline"
    VISUAL = "visual"


class TranscriptionEngine(StrEnum):
    FASTER_WHISPER = "faster-whisper"
    QWEN3_ASR = "qwen3-asr"
    SENSEVOICE = "sensevoice"


class TranscriptionDevice(StrEnum):
    AUTO = "auto"
    CPU = "cpu"
    CUDA = "cuda"


class TranscriptionComputeType(StrEnum):
    AUTO = "auto"
    INT8 = "int8"
    FLOAT16 = "float16"


class TranscriptionIntegrationStatus(StrEnum):
    AVAILABLE = "available"
    ADAPTER_REQUIRED = "adapter_required"


class TranscriptionModelInstallationStatus(StrEnum):
    NOT_INSTALLED = "not_installed"
    DOWNLOADING = "downloading"
    INSTALLED = "installed"
    FAILED = "failed"


class TranscriptionModelDownloadStage(StrEnum):
    PENDING = "pending"
    RESOLVING = "resolving"
    DOWNLOADING = "downloading"
    COMPLETE = "complete"
    FAILED = "failed"


TERMINAL_TRANSCRIPTION_MODEL_DOWNLOAD_STAGES = {
    TranscriptionModelDownloadStage.COMPLETE,
    TranscriptionModelDownloadStage.FAILED,
}


class TranscriptionModelDescriptor(BaseModel):
    engine: TranscriptionEngine
    model: str
    name: str
    description: str
    accuracy: str
    speed: str
    languages: list[str]
    repository: str
    recommended: bool = False
    integration_status: TranscriptionIntegrationStatus


class TranscriptionModelDownloadJob(BaseModel):
    job_id: str
    engine: TranscriptionEngine
    model: str
    stage: TranscriptionModelDownloadStage = TranscriptionModelDownloadStage.PENDING
    progress_percent: float = 0
    downloaded_bytes: int = 0
    total_bytes: int | None = None
    message: str = "等待下载"
    error_message: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class TranscriptionModelState(TranscriptionModelDescriptor):
    installation_status: TranscriptionModelInstallationStatus
    download_job: TranscriptionModelDownloadJob | None = None


TRANSCRIPTION_MODEL_CATALOG = (
    TranscriptionModelDescriptor(
        engine=TranscriptionEngine.FASTER_WHISPER,
        model="tiny",
        name="Whisper Tiny",
        description="资源占用最低，适合快速预览。",
        accuracy="基础",
        speed="最快",
        languages=["多语言"],
        repository="Systran/faster-whisper-tiny",
        integration_status=TranscriptionIntegrationStatus.AVAILABLE,
    ),
    TranscriptionModelDescriptor(
        engine=TranscriptionEngine.FASTER_WHISPER,
        model="base",
        name="Whisper Base",
        description="轻量转录，适合低配置设备。",
        accuracy="基础",
        speed="很快",
        languages=["多语言"],
        repository="Systran/faster-whisper-base",
        integration_status=TranscriptionIntegrationStatus.AVAILABLE,
    ),
    TranscriptionModelDescriptor(
        engine=TranscriptionEngine.FASTER_WHISPER,
        model="small",
        name="Whisper Small",
        description="当前兼容默认值，兼顾资源占用与识别质量。",
        accuracy="标准",
        speed="快",
        languages=["多语言"],
        repository="Systran/faster-whisper-small",
        integration_status=TranscriptionIntegrationStatus.AVAILABLE,
    ),
    TranscriptionModelDescriptor(
        engine=TranscriptionEngine.FASTER_WHISPER,
        model="medium",
        name="Whisper Medium",
        description="比 Small 更准确，CPU 推理耗时明显增加。",
        accuracy="较高",
        speed="较慢",
        languages=["多语言"],
        repository="Systran/faster-whisper-medium",
        integration_status=TranscriptionIntegrationStatus.AVAILABLE,
    ),
    TranscriptionModelDescriptor(
        engine=TranscriptionEngine.FASTER_WHISPER,
        model="large-v2",
        name="Whisper Large V2",
        description="保留已有大型模型兼容能力。",
        accuracy="高",
        speed="慢",
        languages=["多语言"],
        repository="Systran/faster-whisper-large-v2",
        integration_status=TranscriptionIntegrationStatus.AVAILABLE,
    ),
    TranscriptionModelDescriptor(
        engine=TranscriptionEngine.FASTER_WHISPER,
        model="large-v3-turbo",
        name="Whisper Large V3 Turbo",
        description="高精度与推理速度的推荐平衡方案。",
        accuracy="高",
        speed="较快",
        languages=["多语言", "粤语"],
        repository="dropbox-dash/faster-whisper-large-v3-turbo",
        recommended=True,
        integration_status=TranscriptionIntegrationStatus.AVAILABLE,
    ),
    TranscriptionModelDescriptor(
        engine=TranscriptionEngine.FASTER_WHISPER,
        model="large-v3",
        name="Whisper Large V3",
        description="Whisper 系列最高精度档，适合质量优先任务。",
        accuracy="很高",
        speed="慢",
        languages=["多语言", "粤语"],
        repository="Systran/faster-whisper-large-v3",
        integration_status=TranscriptionIntegrationStatus.AVAILABLE,
    ),
    TranscriptionModelDescriptor(
        engine=TranscriptionEngine.QWEN3_ASR,
        model="qwen3-asr-0.6b",
        name="Qwen3-ASR 0.6B",
        description="面向中文、方言和复杂音频的轻量扩展方案。",
        accuracy="高",
        speed="较快",
        languages=["中文", "22 种中文方言", "多语言"],
        repository="Qwen/Qwen3-ASR-0.6B",
        integration_status=TranscriptionIntegrationStatus.ADAPTER_REQUIRED,
    ),
    TranscriptionModelDescriptor(
        engine=TranscriptionEngine.QWEN3_ASR,
        model="qwen3-asr-1.7b",
        name="Qwen3-ASR 1.7B",
        description="中文高精度扩展方案，时间戳需配合 ForcedAligner。",
        accuracy="最高",
        speed="较慢",
        languages=["中文", "22 种中文方言", "多语言"],
        repository="Qwen/Qwen3-ASR-1.7B",
        integration_status=TranscriptionIntegrationStatus.ADAPTER_REQUIRED,
    ),
    TranscriptionModelDescriptor(
        engine=TranscriptionEngine.SENSEVOICE,
        model="sensevoice-small",
        name="SenseVoice Small",
        description="低延迟中文转录，并可扩展声音事件与情绪识别。",
        accuracy="高",
        speed="很快",
        languages=["中文", "粤语", "英语", "日语", "韩语"],
        repository="FunAudioLLM/SenseVoiceSmall",
        integration_status=TranscriptionIntegrationStatus.ADAPTER_REQUIRED,
    ),
)


def find_transcription_model(
    engine: TranscriptionEngine,
    model: str,
) -> TranscriptionModelDescriptor | None:
    return next(
        (
            descriptor
            for descriptor in TRANSCRIPTION_MODEL_CATALOG
            if descriptor.engine == engine and descriptor.model == model
        ),
        None,
    )


class TranscriptionOptions(BaseModel):
    engine: TranscriptionEngine = TranscriptionEngine.FASTER_WHISPER
    model: str = "small"
    language: str | None = "zh"
    device: TranscriptionDevice = TranscriptionDevice.CPU
    compute_type: TranscriptionComputeType = TranscriptionComputeType.INT8

    @model_validator(mode="after")
    def validate_model_engine(self) -> "TranscriptionOptions":
        if find_transcription_model(self.engine, self.model) is None:
            raise ValueError("转录模型与引擎不匹配")
        if (
            self.device != TranscriptionDevice.CUDA
            and self.compute_type == TranscriptionComputeType.FLOAT16
        ):
            raise ValueError("float16 计算精度要求使用 CUDA 设备")
        return self


class TranscriptionMetadata(BaseModel):
    job_id: str
    asset_id: str
    status: str
    engine: TranscriptionEngine = TranscriptionEngine.FASTER_WHISPER
    output_source: str | None = None
    options: TranscriptionOptions
    started_at: datetime | None = None
    completed_at: datetime | None = None
    duration_seconds: float | None = None
    error_message: str | None = None


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
    operation: AnalysisOperation = AnalysisOperation.ANALYSIS
    mode: AnalysisMode = AnalysisMode.FULL
    marker_ids: list[str] = Field(default_factory=list)
    ai_model_id: str | None = None
    capabilities: list[AnalysisCapability] = Field(default_factory=list)
    stage: AnalysisStage = AnalysisStage.PENDING
    progress_percent: float = 0
    message: str = "等待开始"
    error_message: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
