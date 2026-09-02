from collections.abc import Callable
from pathlib import Path
import asyncio

from fastapi import FastAPI, HTTPException, Request, Response, status
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from openvideo.core.summary_models import (
    SummaryDocument,
    SummaryDocumentCreate,
    SummaryDocumentMove,
    SummaryDocumentUpdate,
    SummaryExportResult,
    SummaryGenerationRequest,
    SummaryGenerationResult,
    SummaryIllustrationJob,
    SummaryMediaArtifact,
    SummaryMediaCreate,
    SummaryPreset,
)
from openvideo.core.summary_presets import summary_presets
from openvideo.summary_manager import (
    SummaryCapacityError,
    SummaryError,
    SummaryManager,
    SummaryNotFoundError,
    SummaryRevisionConflictError,
)
from openvideo.summary_illustration_manager import (
    SummaryIllustrationError,
    SummaryIllustrationManager,
)
from openvideo.ui.event_stream import sse_event

SUMMARY_DOCUMENT_EVENT_POLL_SECONDS = 0.5
SUMMARY_DOCUMENT_EVENT_KEEPALIVE_SECONDS = 15


class SummaryMediaCreateResponse(BaseModel):
    artifact: SummaryMediaArtifact
    document: SummaryDocument


def register_summary_routes(
    app: FastAPI,
    summary_manager: Callable[[], SummaryManager],
    illustration_manager: Callable[[], SummaryIllustrationManager],
) -> None:
    @app.get("/api/summary-presets", response_model=list[SummaryPreset])
    def list_summary_presets() -> list[SummaryPreset]:
        return [preset.model_copy(deep=True) for preset in summary_presets()]

    @app.get(
        "/api/media/assets/{asset_id}/summary-documents",
        response_model=list[SummaryDocument],
    )
    def list_summary_documents(
        asset_id: str,
    ) -> list[SummaryDocument]:
        try:
            return summary_manager().documents(asset_id)
        except SummaryError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.get("/api/media/assets/{asset_id}/summary-documents/events")
    async def summary_document_events(
        asset_id: str,
        request: Request,
    ) -> StreamingResponse:
        try:
            initial_documents = summary_manager().documents(asset_id)
        except SummaryError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

        async def stream_events():
            documents = initial_documents
            previous_signature: tuple[tuple[str, int], ...] | None = None
            idle_seconds = 0.0
            while not await request.is_disconnected():
                signature = tuple(
                    (document.document_id, document.revision) for document in documents
                )
                if signature != previous_signature:
                    payload = [
                        document.model_dump(mode="json") for document in documents
                    ]
                    yield sse_event("documents", payload)
                    previous_signature = signature
                    idle_seconds = 0.0
                elif idle_seconds >= SUMMARY_DOCUMENT_EVENT_KEEPALIVE_SECONDS:
                    yield ": keep-alive\n\n"
                    idle_seconds = 0.0
                await asyncio.sleep(SUMMARY_DOCUMENT_EVENT_POLL_SECONDS)
                idle_seconds += SUMMARY_DOCUMENT_EVENT_POLL_SECONDS
                documents = summary_manager().documents(asset_id)

        return StreamingResponse(
            stream_events(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    @app.post(
        "/api/media/assets/{asset_id}/summary-documents/generate",
        response_model=SummaryGenerationResult,
        status_code=status.HTTP_201_CREATED,
    )
    async def generate_summary_documents(
        asset_id: str,
        request: SummaryGenerationRequest,
    ) -> SummaryGenerationResult:
        try:
            result = await asyncio.to_thread(
                summary_manager().generate,
                asset_id,
                request,
            )
            try:
                job = illustration_manager().create(
                    asset_id,
                    result.project.revision,
                    request.ai_model_id,
                )
                illustration_manager().start(job.job_id)
                return result.model_copy(update={"illustration_job": job})
            except SummaryIllustrationError:
                return result
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except SummaryCapacityError as error:
            raise HTTPException(status_code=409, detail=error.detail) from error
        except SummaryError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.get(
        "/api/summary-illustration-jobs/{job_id}",
        response_model=SummaryIllustrationJob,
    )
    def get_summary_illustration_job(job_id: str) -> SummaryIllustrationJob:
        job = illustration_manager().get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="配图任务不存在")
        return job

    @app.get(
        "/api/media/assets/{asset_id}/summary-illustration-job",
        response_model=SummaryIllustrationJob | None,
    )
    def get_asset_illustration_job(
        asset_id: str,
    ) -> SummaryIllustrationJob | None:
        return illustration_manager().latest_for_asset(asset_id)

    @app.post(
        "/api/summary-documents/{parent_document_id}/children",
        response_model=SummaryDocument,
        status_code=status.HTTP_201_CREATED,
    )
    def create_summary_child(
        parent_document_id: str,
        request: SummaryDocumentCreate,
    ) -> SummaryDocument:
        try:
            return summary_manager().create_child(parent_document_id, request)
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except (SummaryError, ValueError) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.patch(
        "/api/summary-documents/{document_id}",
        response_model=SummaryDocument,
    )
    def update_summary_document(
        document_id: str,
        request: SummaryDocumentUpdate,
    ) -> SummaryDocument:
        try:
            return summary_manager().update_document(document_id, request)
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.post(
        "/api/summary-documents/{document_id}/duplicate",
        response_model=SummaryDocument,
        status_code=status.HTTP_201_CREATED,
    )
    def duplicate_summary_document(document_id: str) -> SummaryDocument:
        try:
            return summary_manager().duplicate_document(document_id)
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except SummaryError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.put(
        "/api/summary-documents/{document_id}/move",
        response_model=list[SummaryDocument],
    )
    def move_summary_document(
        document_id: str,
        request: SummaryDocumentMove,
    ) -> list[SummaryDocument]:
        try:
            return summary_manager().move_document(document_id, request)
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except (SummaryError, ValueError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.delete(
        "/api/summary-documents/{document_id}",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    def delete_summary_document(document_id: str) -> Response:
        try:
            summary_manager().delete_document(document_id)
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @app.post(
        "/api/summary-media",
        response_model=SummaryMediaCreateResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_summary_media(
        request: SummaryMediaCreate,
    ) -> SummaryMediaCreateResponse:
        try:
            artifact, document = await asyncio.to_thread(
                summary_manager().create_media, request
            )
            return SummaryMediaCreateResponse(artifact=artifact, document=document)
        except SummaryRevisionConflictError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except SummaryError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.get("/api/summary-media/{media_id}")
    def get_summary_media(media_id: str) -> FileResponse:
        try:
            return FileResponse(summary_manager().media_path(media_id))
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.get("/assets/{media_file}")
    def get_relative_summary_media(media_file: str) -> FileResponse:
        file_name = Path(media_file)
        if file_name.name != media_file or file_name.suffix not in {".jpg", ".gif"}:
            raise HTTPException(status_code=404, detail="总结媒体不存在")
        try:
            media_path = summary_manager().media_path(file_name.stem)
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        if media_path.suffix != file_name.suffix:
            raise HTTPException(status_code=404, detail="总结媒体不存在")
        return FileResponse(media_path)

    @app.post(
        "/api/media/assets/{asset_id}/summary-exports",
        response_model=SummaryExportResult,
        status_code=status.HTTP_201_CREATED,
    )
    def export_summary(
        asset_id: str,
    ) -> SummaryExportResult:
        try:
            return summary_manager().export(asset_id)
        except SummaryNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except SummaryError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
