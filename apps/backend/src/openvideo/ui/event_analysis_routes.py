from collections.abc import Callable
from datetime import UTC, datetime

from fastapi import FastAPI, HTTPException, Response, status

from openvideo.core.event_analysis_models import (
    EventAnalysis,
    EventAnalysisJob,
    EventAnalysisJobCreate,
    FocusSelection,
    FocusSelectionUpdate,
)
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.event_analysis_manager import EventAnalysisError, EventAnalysisManager
from openvideo.ui.media_routes import ready_asset


def register_event_analysis_routes(
    app: FastAPI,
    library: Callable[[], MediaLibrary],
    manager: Callable[[], EventAnalysisManager],
) -> None:
    @app.get(
        "/api/media/assets/{asset_id}/focus-selection",
        response_model=FocusSelection,
    )
    def get_focus_selection(asset_id: str) -> FocusSelection:
        ready_asset(library(), asset_id)
        selection = library().load_focus_selection(asset_id)
        if selection is None:
            raise HTTPException(status_code=404, detail="该素材还没有焦点选区")
        return selection

    @app.patch(
        "/api/media/assets/{asset_id}/focus-selection",
        response_model=FocusSelection,
    )
    def update_focus_selection(
        asset_id: str,
        request: FocusSelectionUpdate,
    ) -> FocusSelection:
        asset = ready_asset(library(), asset_id)
        current = library().load_focus_selection(asset_id)
        in_seconds = current.in_seconds if current else None
        out_seconds = current.out_seconds if current else None
        if "in_seconds" in request.model_fields_set:
            in_seconds = request.in_seconds
        if "out_seconds" in request.model_fields_set:
            out_seconds = request.out_seconds
        duration = asset.duration_seconds
        if duration is not None and any(
            value is not None and value > duration
            for value in (in_seconds, out_seconds)
        ):
            raise HTTPException(status_code=422, detail="焦点选区端点超出视频范围")
        if (
            "in_seconds" in request.model_fields_set
            and "out_seconds" in request.model_fields_set
            and in_seconds is not None
            and out_seconds is not None
            and in_seconds >= out_seconds
        ):
            raise HTTPException(status_code=422, detail="Out 必须晚于 In")
        if in_seconds is not None and out_seconds is not None and in_seconds >= out_seconds:
            if "in_seconds" in request.model_fields_set:
                out_seconds = None
            else:
                in_seconds = None
        selection = FocusSelection(
            selection_id=(
                current.selection_id
                if current is not None
                else f"focus-selection-{uuid7().hex}"
            ),
            asset_id=asset_id,
            in_seconds=in_seconds,
            out_seconds=out_seconds,
            revision=(current.revision + 1 if current else 1),
            updated_at=datetime.now(UTC),
        )
        return library().save_focus_selection(selection)

    @app.delete(
        "/api/media/assets/{asset_id}/focus-selection",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    def delete_focus_selection(asset_id: str) -> Response:
        ready_asset(library(), asset_id)
        library().delete_focus_selection(asset_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @app.get(
        "/api/media/assets/{asset_id}/event-analyses",
        response_model=list[EventAnalysis],
    )
    def list_event_analyses(asset_id: str) -> list[EventAnalysis]:
        ready_asset(library(), asset_id)
        return library().load_event_analyses(asset_id)

    @app.post(
        "/api/media/assets/{asset_id}/event-analysis-jobs",
        response_model=EventAnalysisJob,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def create_event_analysis_job(
        asset_id: str,
        request: EventAnalysisJobCreate,
    ) -> EventAnalysisJob:
        try:
            job = manager().create(asset_id, request)
        except EventAnalysisError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        manager().start(job.job_id)
        return job

    @app.get(
        "/api/event-analysis-jobs/{job_id}",
        response_model=EventAnalysisJob,
    )
    def get_event_analysis_job(job_id: str) -> EventAnalysisJob:
        job = manager().get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="事件分析任务不存在")
        return job

    @app.delete(
        "/api/event-analyses/{event_analysis_id}",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    def delete_event_analysis(event_analysis_id: str) -> Response:
        if not library().delete_event_analysis(event_analysis_id):
            raise HTTPException(status_code=404, detail="事件分析不存在")
        return Response(status_code=status.HTTP_204_NO_CONTENT)
