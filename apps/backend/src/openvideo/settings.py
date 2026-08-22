from __future__ import annotations

import os
from pathlib import Path

from pydantic import BaseModel, Field

from openvideo.preferences import PreferenceStore, Preferences


DEFAULT_CORS_ORIGINS = ("http://127.0.0.1:5173", "http://localhost:5173")
SETTING_ENVIRONMENTS = {
    "ffmpeg_path": "OPENVIDEO_FFMPEG_PATH",
    "ffprobe_path": "OPENVIDEO_FFPROBE_PATH",
    "tools_directory": "OPENVIDEO_TOOLS_DIRECTORY",
    "models_directory": "OPENVIDEO_MODELS_DIRECTORY",
    "openai_base_url": "OPENVIDEO_OPENAI_BASE_URL",
    "openai_api_key": "OPENVIDEO_OPENAI_API_KEY",
    "vision_model": "OPENVIDEO_VISION_MODEL",
}

PROJECT_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_RUNTIME_DIRECTORY = PROJECT_ROOT / "runtime"
DEFAULT_TOOLS_DIRECTORY = DEFAULT_RUNTIME_DIRECTORY / "tools"
DEFAULT_MODELS_DIRECTORY = DEFAULT_RUNTIME_DIRECTORY / "models"


class Settings(BaseModel):
    library_path: Path | None = None
    ffmpeg_path: str | None = None
    ffprobe_path: str | None = None
    tools_directory: str | None = None
    cors_origins: list[str] = Field(default_factory=lambda: list(DEFAULT_CORS_ORIGINS))
    models_directory: str | None = None
    openai_base_url: str = "https://api.openai.com/v1"
    openai_api_key: str | None = None
    vision_model: str = "gpt-5.6-terra"
    managed_fields: set[str] = Field(default_factory=set)

    @property
    def ffmpeg_bin_dir(self) -> Path:
        tools_directory = (
            Path(self.tools_directory).expanduser().resolve()
            if self.tools_directory
            else DEFAULT_TOOLS_DIRECTORY
        )
        return tools_directory / "ffmpeg" / "bin"

    @property
    def whisper_model_directory(self) -> Path:
        models_directory = (
            Path(self.models_directory).expanduser().resolve()
            if self.models_directory
            else DEFAULT_MODELS_DIRECTORY
        )
        return models_directory / "faster-whisper"


def load_settings(store: PreferenceStore | None = None) -> Settings:
    preferences = (store or PreferenceStore()).load()
    values = preferences.model_dump(exclude={"current_library_path"})
    managed_fields: set[str] = set()
    for field, environment_name in SETTING_ENVIRONMENTS.items():
        if environment_name in os.environ:
            values[field] = os.environ[environment_name] or None
            managed_fields.add(field)
    raw_origins = os.getenv("OPENVIDEO_CORS_ORIGINS")
    origins = (
        [origin.strip() for origin in raw_origins.split(",") if origin.strip()]
        if raw_origins
        else list(DEFAULT_CORS_ORIGINS)
    )
    environment_library = os.getenv("OPENVIDEO_LIBRARY_PATH")
    library_path = _load_library_path(environment_library, preferences.current_library_path)
    return Settings(
        library_path=library_path,
        cors_origins=origins,
        managed_fields=managed_fields,
        **values,
    )


def preferences_from_settings(settings: Settings, current_library_path: str | None) -> Preferences:
    values = settings.model_dump(exclude={"library_path", "cors_origins", "managed_fields"})
    return Preferences(current_library_path=current_library_path, **values)


def _load_library_path(
    environment_path: str | None,
    preferred_path: str | None,
) -> Path | None:
    """资料库必须独立于应用目录，避免升级或卸载时损坏用户数据。"""
    if environment_path:
        resolved_path = Path(environment_path).expanduser().resolve()
        if resolved_path.is_relative_to(PROJECT_ROOT):
            raise ValueError("OPENVIDEO_LIBRARY_PATH 不能指向 OpenVideo 项目目录内部")
        return resolved_path
    if not preferred_path:
        return None
    resolved_path = Path(preferred_path).expanduser().resolve()
    return None if resolved_path.is_relative_to(PROJECT_ROOT) else resolved_path
