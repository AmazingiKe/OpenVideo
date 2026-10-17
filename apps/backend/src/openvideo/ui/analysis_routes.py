from collections.abc import Callable

from fastapi import FastAPI, HTTPException, Query, Response, status
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from openvideo.analysis_manager import (
    AnalysisError,
    AnalysisManager,
    AnalysisPrerequisiteError,
)
from openvideo.core.analysis_models import (
    ANALYSIS_STRATEGY_PRESETS,
    AnalysisJob,
    AnalysisMode,
    AnalysisOperation,
    AnalysisStage,
    AnalysisStrategy,
    AnalysisStrategyPresetDescriptor,
)
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import (
    MarkerContent,
    MarkerImportance,
    MediaMarker,
    MediaSegment,
)
from openvideo.core.transcription_models import (
    Transcript,
    TranscriptVersionSummary,
    TranscriptionComputeType,
    TranscriptionDevice,
    TranscriptionEngine,
    TranscriptionOptions,
    TranscriptionPreflight,
)
from openvideo.settings import Settings
from openvideo.ui.media_routes import ready_asset, validate_marker_bounds


class MarkerCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start_seconds: float = Field(ge=0)
    end_seconds: float | None = Field(default=None, ge=0)
    importance: MarkerImportance = 0
    content: MarkerContent = ""


class MarkerUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start_seconds: float | None = Field(default=None, ge=0)
    end_seconds: float | None = Field(default=None, ge=0)
    importance: MarkerImportance | None = None
    content: MarkerContent | None = None

    @model_validator(mode="after")
    def validate_partial_update(self) -> "MarkerUpdateRequest":
        if not self.model_fields_set:
            raise ValueError("至少需要提交一个标记字段")
        if "start_seconds" in self.model_fields_set and self.start_seconds is None:
            raise ValueError("开始时间不能为 null")
        if "importance" in self.model_fields_set and self.importance is None:
            raise ValueError("重要程度不能为 null")
        if "content" in self.model_fields_set and self.content is None:
            raise ValueError("标记内容不能为 null，请使用空字符串清空")
        return self


class TranscriptSegmentUpdateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=10_000)


class TranscriptionCreateRequest(BaseModel):
    force: bool = False
    engine: TranscriptionEngine | None = None
    model: str | None = None
    language: str | None = None
    device: TranscriptionDevice | None = None
    compute_type: TranscriptionComputeType | None = None


class TranscriptionPreflightRequest(BaseModel):
    asset_ids: list[str] = Field(min_length=1, max_length=200)
    options: TranscriptionOptions


class AnalysisCreateRequest(BaseModel):
    mode: AnalysisMode = AnalysisMode.FULL
    force: bool = False
    ai_model_id: str | None = None
    strategy: AnalysisStrategy = Field(default_factory=AnalysisStrategy)


class AnalysisTaskSnapshot(BaseModel):
    """列表只传控制所需状态，较大的章节预览通过单任务端点读取。"""

    job: AnalysisJob
    transcription_options: TranscriptionOptions | None = None


class CloudSubmissionStatus(BaseModel):
    job_id: str
    uncertain: bool
    cloud_task_id: str | None
    options: TranscriptionOptions


class CloudSubmissionResolution(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: str = Field(min_length=1)
    cloud_task_id: str | None = Field(
        default=None, min_length=1, max_length=200, pattern=r"^[A-Za-z0-9_-]+$"
    )
    confirm_not_submitted: bool = False

    @model_validator(mode="after")
    def validate_resolution(self) -> "CloudSubmissionResolution":
        if bool(self.cloud_task_id) == self.confirm_not_submitted:
            raise ValueError("请填写已有任务号，或确认未生成云端任务")
        return self


DEFAULT_ANALYSIS_HISTORY_LIMIT = 50
MAXIMUM_ANALYSIS_HISTORY_LIMIT = 200


def register_analysis_routes(
    app: FastAPI,
    library: Callable[[], MediaLibrary],
    analysis_manager: Callable[[], AnalysisManager],
    settings: Settings,
) -> None:
    @app.get(
        "/api/media/assets/{asset_id}/transcription-submission",
        response_model=CloudSubmissionStatus | None,
    )
    def get_cloud_submission_status(asset_id: str) -> CloudSubmissionStatus | None:
        media_library = library()
        ready_asset(media_library, asset_id)
        metadata = media_library.load_transcription_metadata(asset_id)
        if metadata is None:
            return None
        return CloudSubmissionStatus(
            job_id=metadata.job_id,
            uncertain=metadata.cloud_submission_uncertain,
            cloud_task_id=metadata.cloud_task_id,
            options=metadata.options,
        )

    @app.post(
        "/api/media/assets/{asset_id}/transcription-submission",
        response_model=CloudSubmissionStatus,
    )
    def resolve_cloud_submission(
        asset_id: str, request: CloudSubmissionResolution
    ) -> CloudSubmissionStatus:
        ready_asset(library(), asset_id)
        try:
            metadata = analysis_manager().resolve_cloud_submission(
                asset_id,
                request.job_id,
                request.cloud_task_id,
                request.confirm_not_submitted,
            )
        except AnalysisError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return CloudSubmissionStatus(
            job_id=metadata.job_id,
            uncertain=metadata.cloud_submission_uncertain,
            cloud_task_id=metadata.cloud_task_id,
            options=metadata.options,
        )

    @app.get("/api/analysis", response_model=list[AnalysisTaskSnapshot])
    def list_analysis_tasks(
        limit: int = Query(
            default=DEFAULT_ANALYSIS_HISTORY_LIMIT,
            ge=1,
            le=MAXIMUM_ANALYSIS_HISTORY_LIMIT,
        ),
    ) -> list[AnalysisTaskSnapshot]:
        media_library = library()
        snapshots: list[AnalysisTaskSnapshot] = []
        for job in analysis_manager().list_jobs(limit):
            options = None
            if job.operation == AnalysisOperation.TRANSCRIPTION:
                metadata = media_library.load_transcription_metadata(job.asset_id)
                if metadata is not None and metadata.job_id == job.job_id:
                    options = metadata.options
            snapshots.append(
                AnalysisTaskSnapshot(
                    job=job.model_copy(update={"proposed_segments": []}),
                    transcription_options=options,
                )
            )
        return snapshots

    @app.post(
        "/api/media/assets/{asset_id}/chapters",
        response_model=AnalysisJob,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def generate_chapters(asset_id: str) -> AnalysisJob:
        try:
            job = analysis_manager().create_chapters(asset_id)
            if job.stage == AnalysisStage.PENDING:
                analysis_manager().start(job.job_id)
        except AnalysisPrerequisiteError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except AnalysisError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        return job

    @app.post(
        "/api/media/assets/{asset_id}/analyze",
        response_model=AnalysisJob,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def analyze_asset(
        asset_id: str,
        request: AnalysisCreateRequest = AnalysisCreateRequest(),
    ) -> AnalysisJob:
        try:
            job = analysis_manager().create_analysis(
                asset_id,
                request.mode,
                request.ai_model_id,
                request.strategy,
                request.force,
            )
            if job.stage.value == "pending":
                analysis_manager().start(job.job_id)
        except AnalysisPrerequisiteError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except AnalysisError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        return job

    @app.get(
        "/api/analysis-strategies",
        response_model=list[AnalysisStrategyPresetDescriptor],
    )
    def list_analysis_strategies() -> list[AnalysisStrategyPresetDescriptor]:
        return [preset.model_copy(deep=True) for preset in ANALYSIS_STRATEGY_PRESETS]

    @app.post("/api/transcription/preflight", response_model=TranscriptionPreflight)
    def check_transcription(
        request: TranscriptionPreflightRequest,
    ) -> TranscriptionPreflight:
        for asset_id in request.asset_ids:
            ready_asset(library(), asset_id)
        return analysis_manager().check_transcription(
            request.asset_ids, request.options
        )

    @app.post(
        "/api/media/assets/{asset_id}/transcribe",
        response_model=AnalysisJob,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def transcribe_asset(
        asset_id: str,
        request: TranscriptionCreateRequest = TranscriptionCreateRequest(),
    ) -> AnalysisJob:
        try:
            option_values = request.model_dump(
                exclude={"force"},
                exclude_unset=True,
            )
            option_values = {
                field: value
                for field, value in option_values.items()
                if value is not None or field == "language"
            }
            default_values = settings.default_transcription.model_dump()
            options = TranscriptionOptions.model_validate(
                {**default_values, **option_values}
            )
            job = analysis_manager().create_transcription(
                asset_id,
                options,
                request.force,
            )
            if job.stage.value != "complete":
                analysis_manager().start(job.job_id)
        except ValidationError as error:
            message = (
                error.errors()[0]
                .get("ctx", {})
                .get(
                    "error",
                    error.errors()[0]["msg"],
                )
            )
            raise HTTPException(status_code=422, detail=str(message)) from error
        except AnalysisPrerequisiteError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except AnalysisError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        return job

    @app.get("/api/analysis/{job_id}", response_model=AnalysisJob)
    def get_analysis(job_id: str) -> AnalysisJob:
        job = analysis_manager().get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="分析任务不存在")
        return job

    @app.post("/api/analysis/{job_id}/approve", response_model=AnalysisJob)
    def approve_analysis(job_id: str) -> AnalysisJob:
        try:
            return analysis_manager().approve_proposal(job_id)
        except AnalysisError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.post("/api/analysis/{job_id}/cancel", response_model=AnalysisJob)
    def cancel_analysis(job_id: str) -> AnalysisJob:
        try:
            return analysis_manager().cancel(job_id)
        except AnalysisError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.post("/api/analysis/{job_id}/reject", response_model=AnalysisJob)
    def reject_analysis(job_id: str) -> AnalysisJob:
        try:
            return analysis_manager().reject_proposal(job_id)
        except AnalysisError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.get(
        "/api/media/assets/{asset_id}/transcript",
        response_model=Transcript,
    )
    def get_transcript(asset_id: str) -> Transcript:
        transcript = analysis_manager().transcript(asset_id)
        if not transcript:
            raise HTTPException(status_code=404, detail="该视频还没有转写结果")
        return transcript

    @app.get(
        "/api/media/assets/{asset_id}/transcript/versions",
        response_model=list[TranscriptVersionSummary],
    )
    def list_transcript_versions(asset_id: str) -> list[TranscriptVersionSummary]:
        ready_asset(library(), asset_id)
        try:
            return [
                TranscriptVersionSummary(
                    version_id=version.version_id,
                    saved_at=version.saved_at,
                    reason=version.reason,
                    segment_count=len(version.transcript.segments),
                )
                for version in library().list_transcript_versions(asset_id)
            ]
        except (OSError, ValueError) as error:
            raise HTTPException(
                status_code=409, detail="字幕历史无法读取，请检查资料库文件"
            ) from error

    @app.get(
        "/api/media/assets/{asset_id}/transcript/versions/{version_id}",
        response_model=Transcript,
    )
    def get_transcript_version(asset_id: str, version_id: str) -> Transcript:
        ready_asset(library(), asset_id)
        try:
            return library().load_transcript_version(asset_id, version_id).transcript
        except (OSError, ValueError) as error:
            raise HTTPException(
                status_code=404, detail="字幕版本不存在或无法读取"
            ) from error

    @app.post(
        "/api/media/assets/{asset_id}/transcript/versions/{version_id}/restore",
        response_model=Transcript,
    )
    def restore_transcript_version(asset_id: str, version_id: str) -> Transcript:
        ready_asset(library(), asset_id)
        try:
            return analysis_manager().restore_transcript_version(asset_id, version_id)
        except AnalysisPrerequisiteError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except AnalysisError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.patch(
        "/api/media/assets/{asset_id}/transcript/segments/{segment_index}",
        response_model=Transcript,
    )
    def update_transcript_segment(
        asset_id: str,
        segment_index: int,
        request: TranscriptSegmentUpdateRequest,
    ) -> Transcript:
        ready_asset(library(), asset_id)
        normalized_text = request.text.strip()
        if not normalized_text:
            raise HTTPException(status_code=422, detail="转写文字不能为空")
        try:
            return analysis_manager().update_transcript_segment(
                asset_id,
                segment_index,
                normalized_text,
            )
        except AnalysisError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.get(
        "/api/media/assets/{asset_id}/segments",
        response_model=list[MediaSegment],
    )
    def get_segments(asset_id: str) -> list[MediaSegment]:
        return analysis_manager().segments(asset_id)

    @app.get(
        "/api/media/assets/{asset_id}/markers",
        response_model=list[MediaMarker],
    )
    def get_markers(asset_id: str) -> list[MediaMarker]:
        ready_asset(library(), asset_id)
        return library().load_markers(asset_id)

    @app.post(
        "/api/media/assets/{asset_id}/markers",
        response_model=MediaMarker,
        status_code=status.HTTP_201_CREATED,
    )
    def create_marker(asset_id: str, request: MarkerCreateRequest) -> MediaMarker:
        asset = ready_asset(library(), asset_id)
        validate_marker_bounds(
            request.start_seconds, request.end_seconds, asset.duration_seconds
        )
        marker = MediaMarker(
            marker_id=f"marker-{uuid7().hex}",
            asset_id=asset_id,
            start_seconds=request.start_seconds,
            end_seconds=request.end_seconds,
            importance=request.importance,
            content=request.content,
        )
        return library().create_marker(marker)

    @app.patch(
        "/api/media/assets/{asset_id}/markers/{marker_id}",
        response_model=MediaMarker,
    )
    def update_marker(
        asset_id: str,
        marker_id: str,
        request: MarkerUpdateRequest,
    ) -> MediaMarker:
        asset = ready_asset(library(), asset_id)
        try:
            current = next(
                marker
                for marker in library().load_markers(asset_id)
                if marker.marker_id == marker_id
            )
        except (StopIteration, ValueError) as error:
            raise HTTPException(status_code=404, detail="标记不存在") from error
        changes = request.model_dump(exclude_unset=True)
        start_seconds = changes.get("start_seconds", current.start_seconds)
        end_seconds = changes.get("end_seconds", current.end_seconds)
        assert isinstance(start_seconds, int | float)
        assert end_seconds is None or isinstance(end_seconds, int | float)
        validate_marker_bounds(start_seconds, end_seconds, asset.duration_seconds)
        try:
            marker = library().update_marker(
                asset_id,
                marker_id,
                changes=changes,
            )
        except ValueError as error:
            raise HTTPException(status_code=404, detail="标记不存在") from error
        if marker is None:
            raise HTTPException(status_code=404, detail="标记不存在")
        return marker

    @app.delete(
        "/api/media/assets/{asset_id}/markers/{marker_id}",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    def delete_marker(asset_id: str, marker_id: str) -> Response:
        ready_asset(library(), asset_id)
        try:
            deleted = library().delete_marker(asset_id, marker_id)
        except ValueError as error:
            raise HTTPException(status_code=404, detail="标记不存在") from error
        if not deleted:
            raise HTTPException(status_code=404, detail="标记不存在")
        return Response(status_code=status.HTTP_204_NO_CONTENT)
