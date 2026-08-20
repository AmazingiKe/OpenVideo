from fastapi.testclient import TestClient

from openvideo.settings import Settings
from openvideo.tools.downloader import PlaylistEntry, PlaylistProbe
from openvideo.ui import api


def test_probe_returns_a_normalized_douyin_download_url(monkeypatch, tmp_path):
    def probe_douyin(*_: object) -> PlaylistProbe:
        return PlaylistProbe(
            is_playlist=False,
            title=None,
            entries=[
                PlaylistEntry(
                    source_video_id="6961737553342991651",
                    url="",
                    title="示例抖音视频",
                    duration_seconds=19,
                    uploader="示例作者",
                )
            ],
            truncated=False,
            total_count=1,
        )

    monkeypatch.setattr(api, "probe_source", probe_douyin)
    app = api.create_app(Settings(library_path=tmp_path))
    with TestClient(app) as client:
        response = client.post(
            "/api/downloads/probe",
            json={"source_url": "https://www.douyin.com/video/6961737553342991651"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["platform"] == "douyin"
    assert payload["entries"][0]["url"] == "https://www.douyin.com/video/6961737553342991651"
