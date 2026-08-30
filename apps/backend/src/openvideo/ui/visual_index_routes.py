from collections.abc import Callable

from fastapi import FastAPI, HTTPException, status

from openvideo.core.visual_index_models import (
    VisualIndexPrepareRequest,
    VisualIndexStatus,
)
from openvideo.visual_index_service import VisualIndexService


def register_visual_index_routes(
    app: FastAPI,
    visual_index_service: Callable[[], VisualIndexService],
) -> None:
    @app.get("/api/visual-index/status", response_model=VisualIndexStatus)
    def get_visual_index_status() -> VisualIndexStatus:
        return visual_index_service().status()

    @app.post(
        "/api/visual-index/prepare",
        response_model=VisualIndexStatus,
        status_code=status.HTTP_202_ACCEPTED,
    )
    def prepare_visual_index(
        request: VisualIndexPrepareRequest,
    ) -> VisualIndexStatus:
        try:
            return visual_index_service().prepare(request.asset_id)
        except ValueError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.post("/api/visual-index/unload", response_model=VisualIndexStatus)
    def unload_visual_index() -> VisualIndexStatus:
        return visual_index_service().unload()
