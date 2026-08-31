from fastapi import FastAPI
from fastapi.testclient import TestClient

from openvideo.settings import Settings
from openvideo.ui.health_routes import register_health_routes


def test_frontend_probe_uses_lightweight_post_endpoint():
    app = FastAPI()
    register_health_routes(app, Settings())

    response = TestClient(app).post("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ready"}
