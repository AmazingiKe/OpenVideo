"""视频内容分析策略与任务状态。"""

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field, model_validator

from openvideo.core.media_models import MediaSegment, VisualAnalysisStatus


MARKER_RANGE_MIN_SECONDS = 0
MARKER_RANGE_MAX_SECONDS = 120
MARKER_RANGE_STEP_SECONDS = 5


class AnalysisStage(StrEnum):
    PENDING = "pending"
    PREPARING_TRANSCRIPTION_MODEL = "preparing_transcription_model"
    EXTRACTING_AUDIO = "extracting_audio"
    TRANSCRIBING = "transcribing"
    BUILDING_TIMELINE = "building_timeline"
    EXTRACTING_FRAMES = "extracting_frames"
    READING_FRAME_TEXT = "reading_frame_text"
    DESCRIBING_VISUALS = "describing_visuals"
    QUEUING_INDEX = "queuing_index"
    WAITING_FOR_APPROVAL = "waiting_for_approval"
    COMPLETE = "complete"
    REJECTED = "rejected"
    FAILED = "failed"


TERMINAL_ANALYSIS_STAGES = {
    AnalysisStage.COMPLETE,
    AnalysisStage.REJECTED,
    AnalysisStage.FAILED,
}
INACTIVE_ANALYSIS_STAGES = {
    *TERMINAL_ANALYSIS_STAGES,
    AnalysisStage.WAITING_FOR_APPROVAL,
}


class AnalysisMode(StrEnum):
    FULL = "full"


class AnalysisOperation(StrEnum):
    CHAPTERS = "chapters"
    TRANSCRIPTION = "transcription"
    ANALYSIS = "analysis"
    INITIALIZATION = "initialization"


class AnalysisCapability(StrEnum):
    TRANSCRIPT = "transcript"
    TIMELINE = "timeline"
    CHAPTERS = "chapters"
    KEY_FRAMES = "key_frames"
    OCR = "ocr"
    VISUAL = "visual"


class AnalysisStrategyPreset(StrEnum):
    COURSE_NOTES = "course_notes"
    FORMULA_DERIVATION = "formula_derivation"
    OPERATION_TUTORIAL = "operation_tutorial"
    CASE_REVIEW = "case_review"
    CUSTOM = "custom"


class AnalysisDepth(StrEnum):
    QUICK = "quick"
    BALANCED = "balanced"
    DEEP = "deep"


class AnalysisWeights(BaseModel):
    core_concepts: int = Field(ge=0, le=100)
    formula_derivation: int = Field(ge=0, le=100)
    case_demonstration: int = Field(ge=0, le=100)
    questions_conclusions: int = Field(ge=0, le=100)
    visual_content: int = Field(ge=0, le=100)
    user_markers: int = Field(ge=0, le=100)


ANALYSIS_STRATEGY_PRESET_WEIGHTS = {
    AnalysisStrategyPreset.COURSE_NOTES: AnalysisWeights(
        core_concepts=90,
        formula_derivation=65,
        case_demonstration=60,
        questions_conclusions=80,
        visual_content=55,
        user_markers=100,
    ),
    AnalysisStrategyPreset.FORMULA_DERIVATION: AnalysisWeights(
        core_concepts=75,
        formula_derivation=100,
        case_demonstration=45,
        questions_conclusions=70,
        visual_content=60,
        user_markers=100,
    ),
    AnalysisStrategyPreset.OPERATION_TUTORIAL: AnalysisWeights(
        core_concepts=65,
        formula_derivation=25,
        case_demonstration=90,
        questions_conclusions=55,
        visual_content=100,
        user_markers=100,
    ),
    AnalysisStrategyPreset.CASE_REVIEW: AnalysisWeights(
        core_concepts=70,
        formula_derivation=35,
        case_demonstration=100,
        questions_conclusions=85,
        visual_content=70,
        user_markers=100,
    ),
}


class AnalysisStrategy(BaseModel):
    """把用户对内容价值的判断固化到任务，保证重跑可以复现同一取舍。"""

    preset: AnalysisStrategyPreset = AnalysisStrategyPreset.COURSE_NOTES
    weights: AnalysisWeights | None = None
    depth: AnalysisDepth = AnalysisDepth.BALANCED
    marker_range_before_seconds: int = Field(
        default=10,
        ge=MARKER_RANGE_MIN_SECONDS,
        le=MARKER_RANGE_MAX_SECONDS,
        multiple_of=MARKER_RANGE_STEP_SECONDS,
    )
    marker_range_after_seconds: int = Field(
        default=20,
        ge=MARKER_RANGE_MIN_SECONDS,
        le=MARKER_RANGE_MAX_SECONDS,
        multiple_of=MARKER_RANGE_STEP_SECONDS,
    )

    @model_validator(mode="after")
    def resolve_weights(self) -> "AnalysisStrategy":
        if self.preset != AnalysisStrategyPreset.CUSTOM:
            self.weights = ANALYSIS_STRATEGY_PRESET_WEIGHTS[self.preset].model_copy(
                deep=True
            )
        elif self.weights is None:
            raise ValueError("自定义分析策略必须提供权重")
        return self


class AnalysisStrategyPresetDescriptor(BaseModel):
    preset: AnalysisStrategyPreset
    name: str
    description: str
    strategy: AnalysisStrategy


ANALYSIS_STRATEGY_PRESETS = (
    AnalysisStrategyPresetDescriptor(
        preset=AnalysisStrategyPreset.COURSE_NOTES,
        name="课程笔记",
        description="突出核心概念、结论与可复习的知识结构。",
        strategy=AnalysisStrategy(preset=AnalysisStrategyPreset.COURSE_NOTES),
    ),
    AnalysisStrategyPresetDescriptor(
        preset=AnalysisStrategyPreset.FORMULA_DERIVATION,
        name="公式推导",
        description="优先保留公式、符号、推导步骤与适用条件。",
        strategy=AnalysisStrategy(preset=AnalysisStrategyPreset.FORMULA_DERIVATION),
    ),
    AnalysisStrategyPresetDescriptor(
        preset=AnalysisStrategyPreset.OPERATION_TUTORIAL,
        name="操作教程",
        description="关注操作步骤、界面变化、输入输出和关键画面。",
        strategy=AnalysisStrategy(preset=AnalysisStrategyPreset.OPERATION_TUTORIAL),
    ),
    AnalysisStrategyPresetDescriptor(
        preset=AnalysisStrategyPreset.CASE_REVIEW,
        name="案例复盘",
        description="突出案例背景、过程、结果、问题与经验。",
        strategy=AnalysisStrategy(preset=AnalysisStrategyPreset.CASE_REVIEW),
    ),
)


class VisualAnalysisCoverage(BaseModel):
    """记录章节级采样执行情况，不把章节比例解释为视频逐帧覆盖率。"""

    total_segments: int = Field(default=0, ge=0)
    sampled_segments: int = Field(default=0, ge=0)
    sampled_frame_count: int = Field(default=0, ge=0)
    skipped_segments: int = Field(default=0, ge=0)
    no_frames_segments: int = Field(default=0, ge=0)
    failed_segments: int = Field(default=0, ge=0)
    not_requested_segments: int = Field(default=0, ge=0)
    unknown_segments: int = Field(default=0, ge=0)

    @classmethod
    def from_segments(cls, segments: list[MediaSegment]) -> "VisualAnalysisCoverage":
        counts = {status: 0 for status in VisualAnalysisStatus}
        sampled_frame_count = 0
        for segment in segments:
            counts[segment.visual_analysis_status] += 1
            if segment.visual_analysis_status == VisualAnalysisStatus.SAMPLED:
                sampled_frame_count += len(segment.key_frame_paths)
        return cls(
            total_segments=len(segments),
            sampled_segments=counts[VisualAnalysisStatus.SAMPLED],
            sampled_frame_count=sampled_frame_count,
            skipped_segments=counts[VisualAnalysisStatus.SKIPPED],
            no_frames_segments=counts[VisualAnalysisStatus.NO_FRAMES],
            failed_segments=counts[VisualAnalysisStatus.FAILED],
            not_requested_segments=counts[VisualAnalysisStatus.NOT_REQUESTED],
            unknown_segments=counts[VisualAnalysisStatus.UNKNOWN],
        )


class AnalysisJob(BaseModel):
    job_id: str
    asset_id: str
    operation: AnalysisOperation = AnalysisOperation.ANALYSIS
    mode: AnalysisMode = AnalysisMode.FULL
    ai_model_id: str | None = None
    strategy: AnalysisStrategy = Field(default_factory=AnalysisStrategy)
    capabilities: list[AnalysisCapability] = Field(default_factory=list)
    visual_coverage: VisualAnalysisCoverage | None = None
    stage: AnalysisStage = AnalysisStage.PENDING
    progress_percent: float = 0
    message: str = "等待开始"
    error_message: str | None = None
    proposal_base_digest: str | None = None
    proposed_segments: list[MediaSegment] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
