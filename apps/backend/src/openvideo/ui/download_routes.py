from collections.abc import Callable
import asyncio

from fastapi import FastAPI, HTTPException, Query, status
from pydantic import BaseModel

from openvideo.core.download_models import (
    DownloadQuality,
    DownloadStage,
    DownloadTask,
)
from openvideo.core.library import FolderNotFoundError, MediaLibrary
from openvideo.core.media_models import SourcePlatform
from openvideo.download_accounts import (
    DownloadAccountError,
    DownloadAccountExpired,
    DownloadAccountStore,
)
from openvideo.download_manager import DownloadManager
from openvideo.tools.downloader import (
    DownloadFailure,
    PlaylistProbe,
    is_authentication_failure,
    probe_source,
)
from openvideo.tools.sources import UnsupportedSourceError, resolve_source


MAX_BATCH_DOWNLOADS = 100
DEFAULT_DOWNLOAD_HISTORY_LIMIT = 50
MAX_DOWNLOAD_HISTORY_LIMIT = 100


class ProbeRequest(BaseModel):
    source_url: str


class ProbeEntry(BaseModel):
    source_video_id: str
    url: str
    title: str | None
    duration_seconds: float | None
    uploader: str | None


class ProbeResponse(BaseModel):
    platform: SourcePlatform
    is_playlist: bool
    title: str | None
    entries: list[ProbeEntry]
    truncated: bool
    total_count: int


class BatchDownloadRequest(BaseModel):
    source_urls: list[str]
    video_quality: DownloadQuality = DownloadQuality.BEST
    folder_id: str | None = None
    automatic_folder_name: str | None = None
    assign_folder: bool = False


def register_download_routes(
    app: FastAPI,
    get_library: Callable[[], MediaLibrary | None],
    get_manager: Callable[[], DownloadManager | None],
    account_store: DownloadAccountStore,
) -> None:
    @app.post("/api/downloads/probe", response_model=ProbeResponse)
    async def probe_download(request: ProbeRequest) -> ProbeResponse:
        try:
            match = resolve_source(request.source_url)
        except UnsupportedSourceError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        probe_target = match.playlist_url or match.normalized_url
        try:
            with account_store.cookie_file(match.platform) as cookie_source:
                probe = await asyncio.to_thread(
                    probe_source,
                    probe_target,
                    match.platform,
                    match.source_video_id,
                    cookie_source,
                )
                if cookie_source is not None:
                    account_store.mark_available(match.platform)
        except DownloadAccountExpired as error:
            raise HTTPException(status_code=401, detail=str(error)) from error
        except DownloadAccountError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except DownloadFailure as error:
            if is_authentication_failure(error):
                account_store.mark_expired(match.platform)
            raise HTTPException(
                status_code=502,
                detail=str(error) or "无法读取视频信息",
            ) from error
        return probe_response(match.platform, probe)

    @app.post(
        "/api/downloads",
        response_model=list[DownloadTask],
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def create_downloads(request: BatchDownloadRequest) -> list[DownloadTask]:
        if not request.source_urls:
            raise HTTPException(status_code=422, detail="请至少提供一个视频地址")
        if len(request.source_urls) > MAX_BATCH_DOWNLOADS:
            raise HTTPException(
                status_code=422,
                detail=f"单次最多下载 {MAX_BATCH_DOWNLOADS} 个视频",
            )
        matches = []
        for source_url in request.source_urls:
            try:
                matches.append(resolve_source(source_url))
            except UnsupportedSourceError as error:
                raise HTTPException(status_code=422, detail=str(error)) from error

        library = require_library(get_library())
        manager = require_manager(get_manager())
        try:
            folder_id = request.folder_id
            if folder_id is None and request.automatic_folder_name:
                folder_id = library.create_or_get_root_folder(
                    request.automatic_folder_name
                ).folder_id
            assign_ready_folder = request.assign_folder or bool(
                request.automatic_folder_name
            )
            jobs = manager.create_batch(
                matches,
                folder_id,
                assign_ready_folder,
                request.video_quality,
            )
        except (FolderNotFoundError, ValueError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        for job in jobs:
            if job.stage != DownloadStage.COMPLETE:
                manager.start(job.job_id)
        return [
            task
            for job in jobs
            if (task := manager.get_task(job.job_id)) is not None
        ]

    @app.get("/api/downloads", response_model=list[DownloadTask])
    def list_downloads(
        limit: int = Query(
            default=DEFAULT_DOWNLOAD_HISTORY_LIMIT,
            ge=1,
            le=MAX_DOWNLOAD_HISTORY_LIMIT,
        ),
    ) -> list[DownloadTask]:
        manager = get_manager()
        return manager.list_tasks(limit) if manager else []

    @app.get("/api/downloads/{job_id}", response_model=DownloadTask)
    def get_download(job_id: str) -> DownloadTask:
        task = require_manager(get_manager()).get_task(job_id)
        if not task:
            raise HTTPException(status_code=404, detail="下载任务不存在")
        return task

    @app.post(
        "/api/downloads/{job_id}/retry",
        response_model=DownloadTask,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def retry_download(job_id: str) -> DownloadTask:
        manager = require_manager(get_manager())
        try:
            job = manager.retry(job_id)
        except LookupError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        if job.stage != DownloadStage.COMPLETE:
            manager.start(job.job_id)
        task = manager.get_task(job.job_id)
        if task is None:
            raise HTTPException(status_code=404, detail="重新下载任务不存在")
        return task


def require_library(library: MediaLibrary | None) -> MediaLibrary:
    if library is None:
        raise HTTPException(status_code=409, detail="尚未打开资料库")
    return library


def require_manager(manager: DownloadManager | None) -> DownloadManager:
    if manager is None:
        raise HTTPException(status_code=409, detail="尚未打开资料库")
    return manager


def probe_response(platform: SourcePlatform, probe: PlaylistProbe) -> ProbeResponse:
    return ProbeResponse(
        platform=platform,
        is_playlist=probe.is_playlist,
        title=probe.title,
        entries=[
            ProbeEntry(
                source_video_id=entry.source_video_id,
                url=entry_download_url(platform, entry.source_video_id, entry.url),
                title=entry.title,
                duration_seconds=entry.duration_seconds,
                uploader=entry.uploader,
            )
            for entry in probe.entries
        ],
        truncated=probe.truncated,
        total_count=probe.total_count,
    )


def entry_download_url(
    platform: SourcePlatform,
    video_id: str,
    raw_url: str,
) -> str:
    """浅层播放列表可能只返回裸 ID，需补成来源解析器可识别的单视频地址。"""
    if platform == SourcePlatform.BILIBILI:
        return raw_url or f"https://www.bilibili.com/video/{video_id}"
    if platform == SourcePlatform.DOUYIN:
        return f"https://www.douyin.com/video/{video_id}"
    if platform == SourcePlatform.YOUTUBE:
        return f"https://www.youtube.com/watch?v={video_id}"
    return raw_url
