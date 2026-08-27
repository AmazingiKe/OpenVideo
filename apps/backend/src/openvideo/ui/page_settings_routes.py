from collections.abc import Callable

from fastapi import FastAPI

from openvideo.core.page_settings import MarkersPageSettings, PageSettingsStore


def register_page_settings_routes(
    app: FastAPI,
    page_settings_store: Callable[[], PageSettingsStore],
) -> None:
    @app.get(
        "/api/page-settings/markers",
        response_model=MarkersPageSettings,
    )
    def get_markers_page_settings() -> MarkersPageSettings:
        return page_settings_store().load_markers()

    @app.put(
        "/api/page-settings/markers",
        response_model=MarkersPageSettings,
    )
    def update_markers_page_settings(
        request: MarkersPageSettings,
    ) -> MarkersPageSettings:
        return page_settings_store().save_markers(request)
