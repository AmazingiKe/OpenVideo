import os
from pathlib import Path

from pydantic import BaseModel, Field


# API 无鉴权且面向局域网开放，默认放行所有来源；可用 OPENVIDEO_CORS_ORIGINS 收紧。
DEFAULT_CORS_ORIGINS = ("*",)
# 本地 ASR 默认值：small 模型兼顾准确度与 CPU 可运行性，中文优先。
DEFAULT_WHISPER_MODEL = "small"
DEFAULT_WHISPER_LANGUAGE = "zh"
DEFAULT_WHISPER_COMPUTE_TYPE = "int8"


class Settings(BaseModel):
    library_path: Path
    ffmpeg_path: str | None = None
    ffprobe_path: str | None = None
    cors_origins: list[str] = Field(default_factory=lambda: list(DEFAULT_CORS_ORIGINS))
    whisper_model: str = DEFAULT_WHISPER_MODEL
    whisper_language: str | None = DEFAULT_WHISPER_LANGUAGE
    whisper_compute_type: str = DEFAULT_WHISPER_COMPUTE_TYPE

    @property
    def ffmpeg_bin_dir(self) -> Path:
        # 项目内工具目录与媒体库同级的 tools/ffmpeg/bin，便于免安装直接使用。
        return self.library_path.parent / "tools" / "ffmpeg" / "bin"


def load_settings() -> Settings:
    """把进程环境集中转换成运行配置，避免路径和安全边界散落在业务代码中。"""
    default_library_path = Path.cwd() / "library"
    library_path = Path(os.getenv("OPENVIDEO_LIBRARY_PATH", default_library_path)).resolve()
    raw_origins = os.getenv("OPENVIDEO_CORS_ORIGINS")
    cors_origins = (
        [origin.strip() for origin in raw_origins.split(",") if origin.strip()]
        if raw_origins
        else list(DEFAULT_CORS_ORIGINS)
    )
    return Settings(
        library_path=library_path,
        ffmpeg_path=os.getenv("OPENVIDEO_FFMPEG_PATH") or None,
        ffprobe_path=os.getenv("OPENVIDEO_FFPROBE_PATH") or None,
        cors_origins=cors_origins,
        whisper_model=os.getenv("OPENVIDEO_WHISPER_MODEL", DEFAULT_WHISPER_MODEL),
        whisper_language=os.getenv("OPENVIDEO_WHISPER_LANGUAGE", DEFAULT_WHISPER_LANGUAGE) or None,
        whisper_compute_type=os.getenv(
            "OPENVIDEO_WHISPER_COMPUTE_TYPE", DEFAULT_WHISPER_COMPUTE_TYPE
        ),
    )
