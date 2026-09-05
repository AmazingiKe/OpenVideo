import asyncio

from fastapi import FastAPI
from fastapi.testclient import TestClient

from openvideo.core.visual_index_models import VisualIndexStatus
from openvideo.ui.visual_index_routes import register_visual_index_routes


def test_prepare_route_schedules_index_on_the_application_event_loop():
    requested_assets = []

    class IndexService:
        def prepare(self, asset_id):
            assert asyncio.get_running_loop().is_running()
            requested_assets.append(asset_id)
            return VisualIndexStatus(model_name="test", model_revision="revision")

    app = FastAPI()
    service = IndexService()
    register_visual_index_routes(app, lambda: service)
    with TestClient(app) as client:
        response = client.post("/api/visual-index/prepare", json={"asset_id": None})

    assert response.status_code == 202
    assert requested_assets == [None]
