"""视频内容分析策略与任务状态。"""

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
    marker_range_before_seconds: int = Field(default=10, ge=0, le=120, multiple_of=5)
    marker_range_after_seconds: int = Field(default=20, ge=0, le=120, multiple_of=5)

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


class AnalysisJob(BaseModel):
    job_id: str
    asset_id: str
    operation: AnalysisOperation = AnalysisOperation.ANALYSIS
    mode: AnalysisMode = AnalysisMode.FULL
    marker_ids: list[str] = Field(default_factory=list)
    ai_model_id: str | None = None
    strategy: AnalysisStrategy = Field(default_factory=AnalysisStrategy)
    capabilities: list[AnalysisCapability] = Field(default_factory=list)
    stage: AnalysisStage = AnalysisStage.PENDING
    progress_percent: float = 0
    message: str = "等待开始"
    error_message: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
