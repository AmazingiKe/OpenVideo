import asyncio
from collections.abc import Callable
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Query, Response, UploadFile, status
from pydantic import BaseModel, Field

from openvideo.agent_service import AgentService
from openvideo.analysis_manager import AnalysisManager
from openvideo.core.folder_models import FolderResponse
from openvideo.core.library import (
    FolderConflictError,
    FolderNotFoundError,
    MediaLibrary,
)
from openvideo.core.media_models import MediaAssetResponse
from openvideo.download_manager import DownloadManager
from openvideo.local_media_import import (
    LocalMediaImportError,
    import_video_directory,
    persist_local_media,
)
from openvideo.settings import Settings
from openvideo.ui.media_routes import ready_asset


class FolderCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    parent_id: str | None = None


class FolderRenameRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class FolderMoveRequest(BaseModel):
    parent_id: str | None = None


class FolderDeleteRequest(BaseModel):
    confirmation_name: str | None = None


class AssetMoveRequest(BaseModel):
    asset_ids: list[str] = Field(min_length=1, max_length=100)
    folder_id: str | None = None


class DirectoryImportRequest(BaseModel):
    path: str = Field(min_length=1)
    include_subfolders: bool = False


class DirectoryImportResponse(BaseModel):
    assets: list[MediaAssetResponse]
    failed_files: list[str]


def register_library_routes(
    app: FastAPI,
    library: Callable[[], MediaLibrary],
    download_manager: Callable[[], DownloadManager | None],
    analysis_manager: Callable[[], AnalysisManager | None],
    agent_service: Callable[[], AgentService | None],
    settings: Settings,
) -> None:
    @app.get("/api/library/folders", response_model=list[FolderResponse])
    def list_folders() -> list[FolderResponse]:
        return library().list_folders()

    @app.post(
        "/api/library/folders",
        response_model=FolderResponse,
        status_code=status.HTTP_201_CREATED,
    )
    def create_folder(request: FolderCreateRequest) -> FolderResponse:
        try:
            return library().create_folder(request.name, request.parent_id)
        except FolderNotFoundError as error:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail=str(error)
            ) from error
        except FolderConflictError as error:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail=str(error)
            ) from error
        except ValueError as error:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
            ) from error

    @app.patch("/api/library/folders/{folder_id}", response_model=FolderResponse)
    def rename_folder(folder_id: str, request: FolderRenameRequest) -> FolderResponse:
        try:
            return library().rename_folder(folder_id, request.name)
        except FolderNotFoundError as error:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail=str(error)
            ) from error
        except FolderConflictError as error:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail=str(error)
            ) from error
        except ValueError as error:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
            ) from error

    @app.put("/api/library/folders/{folder_id}/parent", response_model=FolderResponse)
    def move_folder(folder_id: str, request: FolderMoveRequest) -> FolderResponse:
        try:
            return library().move_folder(folder_id, request.parent_id)
        except FolderNotFoundError as error:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail=str(error)
            ) from error
        except FolderConflictError as error:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail=str(error)
            ) from error
        except ValueError as error:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
            ) from error

    @app.post("/api/media/assets/move", response_model=list[MediaAssetResponse])
    def move_assets(request: AssetMoveRequest) -> list[MediaAssetResponse]:
        media_library = library()
        try:
            assets = media_library.move_assets(request.asset_ids, request.folder_id)
        except FolderNotFoundError as error:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail=str(error)
            ) from error
        except ValueError as error:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
            ) from error
        return [media_library.response_for(asset) for asset in assets]

    @app.post(
        "/api/media/assets/import",
        response_model=MediaAssetResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def import_local_media(
        file: UploadFile = File(...),
    ) -> MediaAssetResponse:
        media_library = library()
        try:
            asset = await asyncio.to_thread(
                persist_local_media,
                media_library,
                settings,
                file.file,
                file.filename,
            )
        except LocalMediaImportError as error:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=str(error),
            ) from error
        except OSError as error:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="媒体文件无法写入资料库",
            ) from error
        finally:
            await file.close()
        return media_library.response_for(asset)

    @app.post(
        "/api/media/assets/import-directory",
        response_model=DirectoryImportResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def import_local_video_directory(
        request: DirectoryImportRequest,
    ) -> DirectoryImportResponse:
        media_library = library()
        try:
            assets, failed_files = await asyncio.to_thread(
                import_video_directory,
                media_library,
                settings,
                Path(request.path),
                include_subfolders=request.include_subfolders,
            )
        except LocalMediaImportError as error:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=str(error),
            ) from error
        except OSError as error:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="无法读取所选文件夹",
            ) from error
        return DirectoryImportResponse(
            assets=[media_library.response_for(asset) for asset in assets],
            failed_files=failed_files,
        )

    @app.delete("/api/media/assets/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
    async def delete_asset(asset_id: str) -> Response:
        media_library = library()
        try:
            asset = media_library.get(asset_id)
        except ValueError as error:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="媒体资源不存在"
            ) from error
        if asset is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="媒体资源不存在"
            )
        await stop_asset_tasks(
            {asset_id},
            download_manager(),
            analysis_manager(),
            agent_service(),
        )
        try:
            media_library.delete_asset(asset_id)
        except (OSError, ValueError) as error:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail=str(error)
            ) from error
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @app.delete(
        "/api/library/folders/{folder_id}", status_code=status.HTTP_204_NO_CONTENT
    )
    async def delete_folder(
        folder_id: str,
        request: FolderDeleteRequest | None = None,
    ) -> Response:
        media_library = library()
        try:
            folder = media_library.get_folder(folder_id)
            asset_ids = media_library.folder_asset_ids(folder_id)
            has_descendants = any(
                candidate.folder_id != folder_id
                and candidate.materialized_path.startswith(folder.materialized_path)
                for candidate in media_library.list_folders()
            )
        except FolderNotFoundError as error:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail=str(error)
            ) from error
        except ValueError as error:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
            ) from error
        if (asset_ids or has_descendants) and (
            request is None or request.confirmation_name != folder.name
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="非空文件夹必须输入完整名称确认永久删除",
            )
        await stop_asset_tasks(
            set(asset_ids),
            download_manager(),
            analysis_manager(),
            agent_service(),
        )
        try:
            for asset_id in asset_ids:
                media_library.delete_asset(asset_id)
            media_library.delete_folder(folder_id)
        except (FolderConflictError, OSError, ValueError) as error:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail=str(error)
            ) from error
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @app.get("/api/media/assets", response_model=list[MediaAssetResponse])
    def list_assets(
        folder_id: str | None = None,
        uncategorized: bool = False,
        search: str | None = Query(default=None, max_length=200),
        sort_by: str = "created_at",
        sort_order: str = "desc",
    ) -> list[MediaAssetResponse]:
        media_library = library()
        try:
            assets = media_library.list(
                folder_id=folder_id,
                uncategorized=uncategorized,
                search=search,
                sort_by=sort_by,
                sort_order=sort_order,
            )
        except FolderNotFoundError as error:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail=str(error)
            ) from error
        except ValueError as error:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
            ) from error
        return [media_library.response_for(asset) for asset in assets]

    @app.get("/api/media/assets/{asset_id}", response_model=MediaAssetResponse)
    def get_asset(asset_id: str) -> MediaAssetResponse:
        media_library = library()
        asset = ready_asset(media_library, asset_id)
        return media_library.response_for(asset)


async def stop_asset_tasks(
    asset_ids: set[str],
    download_manager: DownloadManager | None,
    analysis_manager: AnalysisManager | None,
    agent_service: AgentService | None,
) -> None:
    """永久删除只能在所有关联执行器确认停止后继续，避免后台写回已删除目录。"""
    if not asset_ids:
        return
    cancellers = [
        candidate.cancel_assets(asset_ids)
        for candidate in (download_manager, analysis_manager, agent_service)
        if candidate is not None
    ]
    try:
        results = await asyncio.gather(*cancellers)
    except Exception as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="关联任务无法停止，未删除任何内容",
        ) from error
    if not all(results):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="关联任务无法停止，未删除任何内容",
        )
