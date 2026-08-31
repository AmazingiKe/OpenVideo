from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel

from openvideo.settings import Settings
from openvideo.tools.downloader import yt_dlp_available
from openvideo.tools.media import media_tool_status


class DependencyStatus(BaseModel):
    yt_dlp: bool
    ffmpeg: bool
    ffprobe: bool


class HealthResponse(BaseModel):
    status: str
    dependencies: DependencyStatus


class BackendProbeResponse(BaseModel):
    status: Literal["ready"]


def register_health_routes(app: FastAPI, settings: Settings) -> None:
    @app.post("/api/health", response_model=BackendProbeResponse)
    def probe_backend() -> BackendProbeResponse:
        """高频前端探活只确认 API 可响应，避免反复启动外部工具做依赖检测。"""
        return BackendProbeResponse(status="ready")

    @app.get("/api/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        tools = media_tool_status(
            settings.ffmpeg_path,
            settings.ffprobe_path,
            settings.ffmpeg_bin_dir,
        )
        dependencies = DependencyStatus(
            yt_dlp=yt_dlp_available(),
            ffmpeg=tools.ffmpeg_available,
            ffprobe=tools.ffprobe_available,
        )
        service_status = (
            "ready" if dependencies.yt_dlp and dependencies.ffmpeg else "degraded"
        )
        return HealthResponse(status=service_status, dependencies=dependencies)
