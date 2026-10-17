from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from threading import Event
import os
import sys
import subprocess
from time import monotonic
from unittest.mock import Mock

import pytest

from openvideo.core.download_models import DownloadQuality
from openvideo.core.media_models import SourcePlatform
from openvideo.tools import downloader
from openvideo.tools.downloader import (
    DownloadFailure,
    DownloadMetadata,
    _network_arguments,
    _transfer_directory,
    download_video,
    platform_download_proxy,
)


SOURCE_URL = "https://www.youtube.com/watch?v=BaW_jenozKc"


def test_process_stop_failure_is_not_reported_as_successful_pause(monkeypatch):
    control = downloader.DownloadControl()
    control.stop()
    process = Mock()
    process.poll.return_value = None
    monkeypatch.setattr(
        control, "stop", Mock(side_effect=subprocess.TimeoutExpired("taskkill", 10))
    )
    monkeypatch.setattr(downloader, "_process_tree_running", lambda *_: True)
    monkeypatch.setattr(
        downloader,
        "_stop_process_tree",
        Mock(side_effect=subprocess.TimeoutExpired("taskkill", 10)),
    )
    with pytest.raises(subprocess.TimeoutExpired):
        with control.track(process):
            pytest.fail("仍在运行的进程不应进入已暂停状态")
    assert control._process is process


@pytest.mark.parametrize("pause_before_launch", [False, True])
def test_pause_stops_actual_process_and_preserves_partial_files(
    tmp_path, pause_before_launch
):
    partial_file = tmp_path / "download.mp4.part"
    partial_file.write_bytes(b"partial")
    started = Event()
    control = downloader.DownloadControl()
    command = [
        sys.executable,
        "-c",
        "import time; print('openvideo-progress:1%|1MiB/s|60', flush=True); time.sleep(60)",
    ]
    if pause_before_launch:
        control.stop()
    with ThreadPoolExecutor(max_workers=1) as executor:
        running = executor.submit(
            downloader._run_download,
            command,
            tmp_path,
            lambda *_: started.set(),
            control,
        )
        try:
            if not pause_before_launch:
                assert started.wait(timeout=5)
                control.stop()
            with pytest.raises(downloader.DownloadPaused):
                running.result(timeout=5)
        finally:
            control.stop()
    assert partial_file.read_bytes() == b"partial"


@pytest.mark.skipif(os.name == "nt", reason="验证 POSIX 进程组信号升级")
@pytest.mark.parametrize("parent_exits_first", [False, True])
def test_pause_kills_uncooperative_processes_and_descendants(
    tmp_path, monkeypatch, parent_exits_first
):
    monkeypatch.setattr(downloader, "PROCESS_STOP_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(downloader, "PROCESS_KILL_TIMEOUT_SECONDS", 1)
    started = Event()
    control = downloader.DownloadControl()
    worker_code = (
        "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
        "print('openvideo-progress:1%|1MiB/s|60',flush=True); time.sleep(60)"
    )
    command = [sys.executable, "-c", worker_code]
    if parent_exits_first:
        command = [
            sys.executable,
            "-c",
            "import subprocess,sys,time; "
            "subprocess.Popen([sys.executable,'-c',sys.argv[1]]); time.sleep(60)",
            worker_code,
        ]
    partial_file = tmp_path / "download.mp4.part"
    partial_file.write_bytes(b"partial")
    with ThreadPoolExecutor(max_workers=1) as executor:
        running = executor.submit(
            downloader._run_download,
            command,
            tmp_path,
            lambda *_: started.set(),
            control,
        )
        try:
            assert started.wait(3)
            stop_started = monotonic()
            control.stop()
            with pytest.raises(downloader.DownloadPaused):
                running.result(timeout=3)
            assert monotonic() - stop_started < 3
            assert not control.has_active_execution
        finally:
            control.stop()
    assert partial_file.read_bytes() == b"partial"


def test_download_deadline_applies_while_output_is_silent(tmp_path, monkeypatch):
    monkeypatch.setattr(downloader, "COMMAND_TIMEOUT_SECONDS", 0.1)
    control = downloader.DownloadControl()
    started = monotonic()
    with ThreadPoolExecutor(max_workers=1) as executor:
        running = executor.submit(
            downloader._run_download,
            [sys.executable, "-c", "import time; time.sleep(60)"],
            tmp_path,
            lambda *_: None,
            control,
        )
        try:
            with pytest.raises(DownloadFailure, match="视频下载超时"):
                running.result(timeout=4)
            assert monotonic() - started < 4
            assert not control.has_active_execution
        finally:
            control.stop()


def test_metadata_timeout_reaps_the_owned_process(tmp_path, monkeypatch):
    monkeypatch.setattr(downloader, "METADATA_TIMEOUT_SECONDS", 0.1)
    popen = subprocess.Popen
    processes = []

    def start_silent_process(command, **options):
        if "yt_dlp" not in command:
            return popen(command, **options)
        process = popen(
            [sys.executable, "-c", "import time; time.sleep(60)"], **options
        )
        processes.append(process)
        return process

    monkeypatch.setattr(downloader.subprocess, "Popen", start_silent_process)
    control = downloader.DownloadControl()
    try:
        with pytest.raises(DownloadFailure, match="读取视频信息超时"):
            downloader.read_download_metadata(
                SOURCE_URL, SourcePlatform.YOUTUBE, control=control
            )
        assert len(processes) == 1
        assert processes[0].poll() is not None
        assert not control.has_active_execution
    finally:
        control.stop()


def test_windows_job_is_terminated_even_after_its_parent_has_exited(monkeypatch):
    monkeypatch.setattr(downloader, "IS_WINDOWS", True)
    monkeypatch.setattr(downloader, "PROCESS_STOP_TIMEOUT_SECONDS", 0)
    process = Mock()
    process.poll.return_value = 0
    process.returncode = 0
    windows_job = Mock()
    active = True

    def terminate_job():
        nonlocal active
        active = False

    windows_job.is_running.side_effect = lambda: active
    windows_job.terminate.side_effect = terminate_job

    assert downloader._process_tree_running(process, windows_job)
    downloader._stop_process_tree(process, windows_job)

    windows_job.terminate.assert_called_once()
    process.terminate.assert_not_called()
    assert not downloader._process_tree_running(process, windows_job)


def test_windows_process_runs_only_after_its_job_owns_it(monkeypatch):
    monkeypatch.setattr(downloader, "IS_WINDOWS", True)
    process = Mock()
    process.poll.return_value = 0
    process.returncode = 0
    windows_job = Mock()
    windows_job.is_running.return_value = False
    transitions = []

    def create_job(_process_id):
        transitions.append("owned")
        return windows_job

    monkeypatch.setattr(downloader, "WindowsProcessJob", create_job)
    monkeypatch.setattr(
        downloader,
        "resume_suspended_process",
        lambda _: transitions.append("resumed"),
    )
    with downloader.DownloadControl().track(process):
        transitions.append("executed")

    assert transitions == ["owned", "resumed", "executed"]
    windows_job.close.assert_called_once()


@pytest.mark.skipif(os.name != "nt", reason="需要真实 Windows Job Object")
def test_windows_pause_reaps_children_after_parent_exit(tmp_path, monkeypatch):
    monkeypatch.setattr(downloader, "PROCESS_STOP_TIMEOUT_SECONDS", 0.05)
    started = Event()
    control = downloader.DownloadControl()
    child_code = "import time; print('openvideo-progress:1%|1MiB/s|60',flush=True); time.sleep(60)"
    command = [
        sys.executable,
        "-c",
        "import subprocess,sys,time; "
        "subprocess.Popen([sys.executable,'-c',sys.argv[1]]); time.sleep(60)",
        child_code,
    ]
    with ThreadPoolExecutor(max_workers=1) as executor:
        running = executor.submit(
            downloader._run_download,
            command,
            tmp_path,
            lambda *_: started.set(),
            control,
        )
        try:
            assert started.wait(3)
            control._process.terminate()
            control._process.wait(timeout=1)
            assert control.has_active_execution
            control.stop()
            with pytest.raises(downloader.DownloadPaused):
                running.result(timeout=3)
            assert not control.has_active_execution
        finally:
            control.stop()


def test_unreaped_output_reader_does_not_report_safe_completion(tmp_path, monkeypatch):
    monkeypatch.setattr(downloader, "COMMAND_TIMEOUT_SECONDS", 0.01)
    reader = Mock()
    reader.is_alive.return_value = True
    monkeypatch.setattr(downloader, "Thread", lambda **_: reader)
    control = downloader.DownloadControl()
    with pytest.raises(DownloadFailure, match="输出读取尚未退出"):
        downloader._read_download_output(Mock(), tmp_path, lambda *_: None, control)
    assert control.has_active_execution


def test_transfer_directory_reuses_matching_partial_files(tmp_path: Path):
    staging_root = tmp_path / "staging"
    first_directory = _transfer_directory(
        staging_root,
        SOURCE_URL,
        SourcePlatform.YOUTUBE,
        DownloadQuality.FULL_HD_1080,
    )
    partial_file = first_directory / "download.f137.mp4.part"
    partial_file.write_bytes(b"partial")

    retry_directory = _transfer_directory(
        staging_root,
        SOURCE_URL,
        SourcePlatform.YOUTUBE,
        DownloadQuality.FULL_HD_1080,
    )
    different_quality_directory = _transfer_directory(
        staging_root,
        SOURCE_URL,
        SourcePlatform.YOUTUBE,
        DownloadQuality.HD_720,
    )

    assert retry_directory == first_directory
    assert partial_file.read_bytes() == b"partial"
    assert different_quality_directory != first_directory


def test_network_arguments_include_retries_and_optional_proxy():
    arguments = _network_arguments("http://127.0.0.1:7890")

    assert arguments[arguments.index("--socket-timeout") + 1] == "30"
    assert arguments[arguments.index("--fragment-retries") + 1] == "20"
    assert arguments.count("--retry-sleep") == 2
    assert arguments[-2:] == ["--proxy", "http://127.0.0.1:7890"]


def test_proxy_is_only_used_for_overseas_platforms():
    configured_proxy = "http://127.0.0.1:7890"

    assert (
        platform_download_proxy(SourcePlatform.YOUTUBE, configured_proxy)
        == configured_proxy
    )
    assert platform_download_proxy(SourcePlatform.BILIBILI, configured_proxy) == ""
    assert platform_download_proxy(SourcePlatform.DOUYIN, configured_proxy) == ""
    assert _network_arguments("")[-2:] == ["--proxy", ""]


def test_failed_download_keeps_partial_and_retry_resumes_it(
    monkeypatch, tmp_path: Path
):
    asset_directory = tmp_path / "asset" / "media"
    asset_directory.mkdir(parents=True)
    staging_root = tmp_path / "temp" / "download-asset"
    commands: list[list[str]] = []
    attempts = 0

    monkeypatch.setattr(downloader, "yt_dlp_available", lambda: True)
    monkeypatch.setattr(downloader, "resolve_tool", lambda *_: "ffmpeg")
    monkeypatch.setattr(
        downloader,
        "read_download_metadata",
        lambda *_, **__: DownloadMetadata(
            source_video_id="BaW_jenozKc",
            title="续传测试",
            author_name=None,
            description=None,
            duration_seconds=30,
            width=1280,
            height=720,
            thumbnail_url=None,
        ),
    )

    def run_download(command, transfer_directory, _on_progress, _control):
        nonlocal attempts
        attempts += 1
        commands.append(command)
        partial_file = transfer_directory / "download.f137.mp4.part"
        if attempts == 1:
            partial_file.write_bytes(b"partial")
            raise DownloadFailure("网络连接中断")
        assert partial_file.read_bytes() == b"partial"
        output_file = transfer_directory / "download.mp4"
        output_file.write_bytes(b"complete")
        return output_file

    monkeypatch.setattr(downloader, "_run_download", run_download)
    callbacks = (lambda *_: None, lambda *_: None, lambda *_: None)

    with pytest.raises(DownloadFailure, match="网络连接中断"):
        download_video(
            SOURCE_URL,
            SourcePlatform.YOUTUBE,
            asset_directory,
            None,
            None,
            *callbacks,
            video_quality=DownloadQuality.HD_720,
            staging_directory=staging_root,
            download_proxy="http://127.0.0.1:7890",
        )

    downloaded = download_video(
        SOURCE_URL,
        SourcePlatform.YOUTUBE,
        asset_directory,
        None,
        None,
        *callbacks,
        video_quality=DownloadQuality.HD_720,
        staging_directory=staging_root,
        download_proxy="http://127.0.0.1:7890",
    )

    assert downloaded.playback_file.read_bytes() == b"complete"
    assert "--continue" in commands[1]
    assert "--part" in commands[1]
    assert commands[1][commands[1].index("--concurrent-fragments") + 1] == "4"
    assert commands[1][commands[1].index("--proxy") + 1] == ("http://127.0.0.1:7890")
    assert not staging_root.exists()
