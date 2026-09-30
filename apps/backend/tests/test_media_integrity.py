from __future__ import annotations

import json
import subprocess
from contextlib import nullcontext
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from openvideo import download_manager
from openvideo.core.download_models import DownloadStage
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import MediaAssetStatus, SourcePlatform
from openvideo.download_manager import DownloadManager
from openvideo.settings import Settings
from openvideo.tools import media
from openvideo.tools.downloader import DownloadedMedia, DownloadMetadata
from openvideo.tools.media import (
    MediaIntegrityError,
    MediaProbe,
    probe_media,
    validate_video_duration,
)
from openvideo.tools.sources import SourceMatch


FULL_DURATION_SECONDS = 2170.0
SHORT_VIDEO_SECONDS = 835.5
FULL_PROBE = MediaProbe(
    FULL_DURATION_SECONDS,
    1920,
    1080,
    "h264",
    "aac",
    FULL_DURATION_SECONDS,
    FULL_DURATION_SECONDS,
)


def test_probe_keeps_stream_durations_separate_from_the_container(
    monkeypatch, tmp_path
):
    payload = {
        "format": {"duration": "2169.997642"},
        "streams": [
            {
                "codec_type": "video",
                "codec_name": "h264",
                "width": 1920,
                "height": 1080,
                "duration": "835.500313",
            },
            {"codec_type": "audio", "codec_name": "aac", "duration": "2169.997642"},
        ],
    }
    monkeypatch.setattr(media, "resolve_tool", lambda *_: "ffprobe")
    monkeypatch.setattr(
        media.subprocess,
        "run",
        lambda command, **_kwargs: subprocess.CompletedProcess(
            command, 0, json.dumps(payload)
        ),
    )
    probe = probe_media(tmp_path / "download.mp4", None)
    assert probe.duration_seconds == 2169.997642
    assert probe.video_duration_seconds == 835.500313
    assert probe.audio_duration_seconds == 2169.997642
    with pytest.raises(MediaIntegrityError, match="835.50.*2170.00"):
        validate_video_duration(probe, FULL_DURATION_SECONDS)


@pytest.mark.parametrize(
    ("duration", "duration_ticks", "time_base", "expected"),
    [
        ("N/A", 480000, "1/48000", 10.0),
        ("nan", None, None, None),
        ("inf", 100, "0/0", None),
        ("-3", 100, "bad", None),
        (None, None, "1/30", None),
    ],
)
def test_probe_falls_back_to_finite_stream_clock(
    monkeypatch, tmp_path, duration, duration_ticks, time_base, expected
):
    payload = {
        "streams": [
            {
                "codec_type": "video",
                "codec_name": "h264",
                "duration": duration,
                "duration_ts": duration_ticks,
                "time_base": time_base,
            }
        ]
    }
    monkeypatch.setattr(media, "resolve_tool", lambda *_: "ffprobe")
    monkeypatch.setattr(
        media.subprocess,
        "run",
        lambda command, **_kwargs: subprocess.CompletedProcess(
            command, 0, json.dumps(payload)
        ),
    )
    assert probe_media(tmp_path / "video.mp4", None).video_duration_seconds == expected


@pytest.mark.parametrize(
    "probe",
    [
        replace(FULL_PROBE, video_duration_seconds=SHORT_VIDEO_SECONDS),
        replace(
            FULL_PROBE,
            duration_seconds=SHORT_VIDEO_SECONDS,
            video_duration_seconds=SHORT_VIDEO_SECONDS,
            audio_duration_seconds=None,
        ),
        replace(FULL_PROBE, video_duration_seconds=None),
        replace(FULL_PROBE, video_duration_seconds=0),
        replace(FULL_PROBE, video_codec=None),
    ],
)
def test_known_short_or_unverifiable_video_is_not_accepted(probe):
    with pytest.raises(MediaIntegrityError):
        validate_video_duration(probe, FULL_DURATION_SECONDS)


@pytest.mark.parametrize(
    ("probe", "expected"),
    [
        (FULL_PROBE, FULL_DURATION_SECONDS),
        (replace(FULL_PROBE, video_duration_seconds=2169.8), 2170.033),
        (replace(FULL_PROBE, audio_codec=None, audio_duration_seconds=None), 2170),
        (replace(FULL_PROBE, audio_duration_seconds=800), 2170),
        (replace(FULL_PROBE, duration_seconds=None, audio_duration_seconds=None), None),
    ],
)
def test_complete_silent_or_slightly_different_streams_remain_supported(
    probe, expected
):
    validate_video_duration(probe, expected)


@pytest.mark.asyncio
async def test_short_video_fails_download_without_publishing_or_starting_analysis(
    monkeypatch, tmp_path: Path
):
    library_directory = tmp_path / "library"
    library_directory.mkdir()
    library = MediaLibrary.initialize_directory(library_directory)
    settings = Settings(library_path=library_directory)
    source = SourceMatch(
        platform=SourcePlatform.BILIBILI,
        normalized_url="https://www.bilibili.com/video/BV1V9PnzrExw/",
        source_video_id="BV1V9PnzrExw",
        is_playlist=False,
    )
    produced_files = []

    def downloaded(_url, _platform, media_directory, *_args, **_kwargs):
        path = media_directory / "playback.mp4"
        path.write_bytes(b"diagnostic-media")
        produced_files.append(path)
        return DownloadedMedia(
            metadata=DownloadMetadata(
                source_video_id=source.source_video_id,
                title="真实样例完整性回归",
                author_name=None,
                description=None,
                duration_seconds=FULL_DURATION_SECONDS,
                width=1920,
                height=1080,
                thumbnail_url=None,
            ),
            playback_file=path,
            thumbnail_file=None,
        )

    monkeypatch.setattr(download_manager, "download_video", downloaded)
    monkeypatch.setattr(
        download_manager,
        "probe_media",
        lambda *_: replace(FULL_PROBE, video_duration_seconds=SHORT_VIDEO_SECONDS),
    )
    account_store = SimpleNamespace(cookie_file=lambda _: nullcontext(None))
    manager = DownloadManager(library, settings, account_store)
    try:
        created = manager.create(source)
        await manager._run(created.job_id)
        failed = manager.get(created.job_id)
        asset = library.get(created.asset_id)
        assert failed.stage == DownloadStage.FAILED
        assert "835.50" in failed.error_message and "2170.00" in failed.error_message
        assert asset.status == MediaAssetStatus.FAILED
        assert asset.playback_path is None
        assert produced_files[0].read_bytes() == b"diagnostic-media"
        assert library.load_analysis_jobs() == []
        assert not manager.has_active_jobs()

        monkeypatch.setattr(download_manager, "probe_media", lambda *_: FULL_PROBE)
        retried = manager.create(source)
        await manager._run(retried.job_id)
        assert retried.asset_id == created.asset_id
        assert manager.get(retried.job_id).stage == DownloadStage.COMPLETE
        assert library.get(created.asset_id).status == MediaAssetStatus.READY
    finally:
        library.close()


@pytest.mark.parametrize("origin", [0, 100, -5])
def test_intentional_video_delay_compares_normalized_end_times(origin):
    probe = MediaProbe(
        10,
        1920,
        1080,
        "h264",
        "aac",
        6,
        10,
        start_seconds=origin,
        video_start_seconds=origin + 4,
        audio_start_seconds=origin,
    )
    validate_video_duration(probe, 10)


def test_missing_probe_does_not_mark_a_download_complete(monkeypatch, tmp_path):
    monkeypatch.setattr(media, "resolve_tool", lambda *_: None)
    probe = probe_media(tmp_path / "download.mp4", None)
    with pytest.raises(MediaIntegrityError, match="没有可识别的视频轨道"):
        validate_video_duration(probe, 20)


def test_probe_timeout_remains_bounded(monkeypatch, tmp_path):
    monkeypatch.setattr(media, "resolve_tool", lambda *_: "ffprobe")

    def timeout(command, **kwargs):
        assert kwargs["timeout"] == media.PROBE_TIMEOUT_SECONDS
        raise subprocess.TimeoutExpired(command, kwargs["timeout"])

    monkeypatch.setattr(media.subprocess, "run", timeout)
    with pytest.raises(subprocess.TimeoutExpired):
        probe_media(tmp_path / "download.mp4", None)
