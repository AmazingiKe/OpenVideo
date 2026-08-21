from __future__ import annotations

import os
from pathlib import Path

from pydantic import BaseModel, Field

from openvideo.preferences import PreferenceStore, Preferences


DEFAULT_CORS_ORIGINS = ("http://127.0.0.1:5173", "http://localhost:5173")
SETTING_ENVIRONMENTS = {
    "ffmpeg_path": "OPENVIDEO_FFMPEG_PATH",
    "ffprobe_path": "OPENVIDEO_FFPROBE_PATH",
    "whisper_model": "OPENVIDEO_WHISPER_MODEL",
    "whisper_language": "OPENVIDEO_WHISPER_LANGUAGE",
    "whisper_compute_type": "OPENVIDEO_WHISPER_COMPUTE_TYPE",
    "openai_base_url": "OPENVIDEO_OPENAI_BASE_URL",
    "openai_api_key": "OPENVIDEO_OPENAI_API_KEY",
    "vision_model": "OPENVIDEO_VISION_MODEL",
}


class Settings(BaseModel):
    library_path: Path | None = None
    ffmpeg_path: str | None = None
    ffprobe_path: str | None = None
    cors_origins: list[str] = Field(default_factory=lambda: list(DEFAULT_CORS_ORIGINS))
    whisper_model: str = "small"
    whisper_language: str | None = "zh"
    whisper_compute_type: str = "int8"
    openai_base_url: str = "https://api.openai.com/v1"
    openai_api_key: str | None = None
    vision_model: str = "gpt-5.6-terra"
    managed_fields: set[str] = Field(default_factory=set)

    @property
    def ffmpeg_bin_dir(self) -> Path:
        configured = os.getenv("OPENVIDEO_TOOLS_PATH")
        return Path(configured).resolve() if configured else Path.cwd() / "tools" / "ffmpeg" / "bin"


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
    library_path = environment_library or preferences.current_library_path
    return Settings(
        library_path=Path(library_path).resolve() if library_path else None,
        cors_origins=origins,
        managed_fields=managed_fields,
        **values,
    )


def preferences_from_settings(settings: Settings, current_library_path: str | None) -> Preferences:
    values = settings.model_dump(exclude={"library_path", "cors_origins", "managed_fields"})
    return Preferences(current_library_path=current_library_path, **values)
