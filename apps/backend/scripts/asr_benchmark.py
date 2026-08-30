"""在不改写资料库字幕的前提下运行可恢复的本地 ASR 基准。

测试产物独立保存，单个模型或素材失败不会阻止后续组合继续运行，便于夜间
无人值守测试后从结果文件恢复。
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import re
import shutil
import sqlite3
import subprocess
import threading
import time
import xml.etree.ElementTree as ElementTree
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import psutil
from rapidfuzz.distance import Levenshtein

from openvideo.core.identifiers import uuid7
from openvideo.core.download_models import DownloadStage
from openvideo.core.library import MediaLibrary
from openvideo.core.transcription_models import (
    TRANSCRIPTION_MODEL_CATALOG,
    Transcript,
    TranscriptionComputeType,
    TranscriptionDevice,
    TranscriptionEngine,
    TranscriptionOptions,
    find_transcription_model,
)
from openvideo.tools.transcribe import (
    create_transcriber,
    extract_audio,
    extract_platform_subtitles,
)
from openvideo.tools.ocr import LocalOcrReader
from openvideo.download_accounts import DownloadAccountStore
from openvideo.download_manager import DownloadManager
from openvideo.settings import load_settings
from openvideo.transcription_model_manager import (
    download_transcription_model,
    is_transcription_model_installed,
    transcription_model_resources,
)


GAMES101_SOURCE_ID = "BV1X7411F744"
SHORT_REFERENCE_EPISODE = 23
REPRESENTATIVE_EPISODES = (2, 3, 5)
REPRESENTATIVE_START_SECONDS = 600
REPRESENTATIVE_DURATION_SECONDS = 480
AUDIO_SAMPLE_RATE = 16_000
AUDIO_CHANNELS = 1
RESOURCE_SAMPLE_INTERVAL_SECONDS = 0.5
DOWNLOAD_STATUS_POLL_SECONDS = 1
MAX_VIDEO_DOWNLOAD_ATTEMPTS = 3
MODEL_KEY_SEPARATOR = ":"
SUCCESS_STATUS = "success"
FAILED_STATUS = "failed"
REPORT_FILE_NAME = "report.md"
RESULTS_FILE_NAME = "metrics.json"
RESULTS_CSV_FILE_NAME = "metrics.csv"
STATE_FILE_NAME = "benchmark.json"
EXTERNAL_REFERENCE_KIND = "公开 AI 字幕代理参考（非人工金标）"
INVALID_MEDIA_CONTENT = b"OpenVideo invalid media fixture"
FORMULA_EXPECTATIONS = (
    r"\hat{a}=\vec{a}/\lVert\vec{a}\rVert",
    r"\vec{a}+\vec{b}",
    r"A=4X+3Y",
    r"A=(x,y)^T",
    r"A^T=(x,y)",
    r"\lVert A\rVert=\sqrt{x^2+y^2}",
    r"\vec{a}\cdot\vec{b}=\lVert\vec{a}\rVert\lVert\vec{b}\rVert\cos\theta",
    r"\cos\theta=(\vec{a}\cdot\vec{b})/(\lVert\vec{a}\rVert\lVert\vec{b}\rVert)",
    r"\cos\theta=\hat{a}\cdot\hat{b}",
)
PROFESSIONAL_TERM_ALIASES = (
    ("计算机图形学",),
    ("向量",),
    ("单位向量",),
    ("归一化", "正规化"),
    ("线性代数",),
    ("矩阵",),
    ("转置",),
    ("单位矩阵",),
    ("逆矩阵",),
    ("正交",),
    ("笛卡尔坐标", "卡特西安坐标"),
    ("点积", "点乘", "内积"),
    ("叉积", "叉乘", "外积"),
    ("齐次坐标",),
    ("光栅化", "栅格化"),
    ("反走样", "抗锯齿", "反锯齿"),
    ("深度缓冲", "z-buffer", "z buffer"),
    ("纹理映射",),
    ("贝塞尔曲线",),
    ("光线追踪",),
    ("辐射度量学",),
    ("蒙特卡洛",),
    ("路径追踪",),
    ("brdf",),
)


@dataclass(frozen=True)
class VideoAsset:
    episode: int
    asset_id: str
    title: str
    source_url: str
    media_path: Path
    duration_seconds: float


@dataclass(frozen=True)
class BenchmarkCase:
    case_id: str
    episode: int
    title: str
    audio_path: Path
    source_start_seconds: float
    duration_seconds: float
    reference_path: Path | None


class ResourceSampler:
    """记录整个推理进程的资源峰值，用于发现模型无法稳定运行的配置。"""

    def __init__(self) -> None:
        self.process = psutil.Process()
        self.peak_rss_bytes = 0
        self.peak_gpu_memory_mib: int | None = None
        self._stopped = threading.Event()
        self._thread = threading.Thread(target=self._sample, daemon=True)

    def __enter__(self) -> ResourceSampler:
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stopped.set()
        self._thread.join(timeout=2)

    def _sample(self) -> None:
        while not self._stopped.is_set():
            self.peak_rss_bytes = max(
                self.peak_rss_bytes,
                self.process.memory_info().rss,
            )
            gpu_memory = _gpu_memory_used_mib()
            if gpu_memory is not None:
                self.peak_gpu_memory_mib = max(
                    self.peak_gpu_memory_mib or 0,
                    gpu_memory,
                )
            self._stopped.wait(RESOURCE_SAMPLE_INTERVAL_SECONDS)


def main() -> None:
    arguments = _parse_arguments()
    if arguments.command == "prepare":
        prepare_benchmark(arguments.library, arguments.output)
    elif arguments.command == "download":
        download_models(arguments.models, arguments.model)
    elif arguments.command == "run":
        run_benchmark(
            arguments.library,
            arguments.output,
            arguments.models,
            arguments.model,
            arguments.scope,
        )
    elif arguments.command == "import-references":
        import_external_references(arguments.output, arguments.source)
    elif arguments.command == "faults":
        run_real_fault_cases(arguments.output, arguments.models)
    elif arguments.command == "snapshot-downloads":
        snapshot_downloads(arguments.library, arguments.output, arguments.models)
    elif arguments.command == "formula-ocr":
        run_formula_ocr(arguments.output)
    elif arguments.command == "resume-video-downloads":
        asyncio.run(resume_video_downloads(arguments.library))
    elif arguments.command == "report":
        build_report(arguments.output)


def _parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="OpenVideo ASR 基准测试")
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare_parser = subparsers.add_parser("prepare")
    prepare_parser.add_argument("--library", type=Path, required=True)
    prepare_parser.add_argument("--output", type=Path, required=True)

    download_parser = subparsers.add_parser("download")
    download_parser.add_argument("--models", type=Path, required=True)
    download_parser.add_argument("--model", action="append")

    run_parser = subparsers.add_parser("run")
    run_parser.add_argument("--library", type=Path, required=True)
    run_parser.add_argument("--output", type=Path, required=True)
    run_parser.add_argument("--models", type=Path, required=True)
    run_parser.add_argument("--model", required=True)
    run_parser.add_argument(
        "--scope",
        choices=("representative", "short-reference", "qwen-ready"),
        default="representative",
    )

    references_parser = subparsers.add_parser("import-references")
    references_parser.add_argument("--output", type=Path, required=True)
    references_parser.add_argument("--source", type=Path, required=True)

    faults_parser = subparsers.add_parser("faults")
    faults_parser.add_argument("--output", type=Path, required=True)
    faults_parser.add_argument("--models", type=Path, required=True)

    downloads_parser = subparsers.add_parser("snapshot-downloads")
    downloads_parser.add_argument("--library", type=Path, required=True)
    downloads_parser.add_argument("--output", type=Path, required=True)
    downloads_parser.add_argument("--models", type=Path, required=True)

    formula_parser = subparsers.add_parser("formula-ocr")
    formula_parser.add_argument("--output", type=Path, required=True)

    resume_parser = subparsers.add_parser("resume-video-downloads")
    resume_parser.add_argument("--library", type=Path, required=True)

    report_parser = subparsers.add_parser("report")
    report_parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def import_external_references(output_path: Path, source_path: Path) -> None:
    """导入无时间戳的公开 AI 字幕，只用于整集代理误差而非金标评测。"""
    target_directory = output_path / "references" / "external"
    target_directory.mkdir(parents=True, exist_ok=True)
    imported_episodes: list[int] = []
    for episode in range(1, 24):
        source_files = sorted(source_path.glob(f"{episode:02d}-*.srt"))
        if not source_files:
            continue
        parts = [_plain_subtitle_text(path) for path in source_files]
        reference_text = "\n".join(part for part in parts if part)
        if not reference_text:
            continue
        target_path = target_directory / f"episode-{episode:02d}.txt"
        target_path.write_text(reference_text + "\n", encoding="utf-8")
        imported_episodes.append(episode)

    state_path = output_path / STATE_FILE_NAME
    state = _read_json(state_path)
    state["external_reference"] = {
        "kind": EXTERNAL_REFERENCE_KIND,
        "source_path": str(source_path.resolve()),
        "imported_at": datetime.now(UTC).isoformat(),
        "episodes": imported_episodes,
    }
    _write_json(state_path, state)
    print(f"REFERENCES_IMPORTED {len(imported_episodes)}", flush=True)


def run_real_fault_cases(output_path: Path, models_path: Path) -> None:
    """用真实媒体栈验证坏输入可隔离，且不会污染已完成的基准结果。"""
    fault_directory = output_path / "robustness" / "real-faults"
    fault_directory.mkdir(parents=True, exist_ok=True)
    cases: list[dict[str, object]] = []

    missing_media_path = fault_directory / "missing-media.mp4"
    try:
        extract_audio(missing_media_path, fault_directory / "missing-output", None)
    except Exception as error:
        cases.append(_fault_result("missing_media", error))
    else:
        cases.append(_unexpected_fault_success("missing_media"))

    corrupt_media_path = fault_directory / "corrupt-media.mp4"
    corrupt_media_path.write_bytes(INVALID_MEDIA_CONTENT)
    try:
        extract_audio(corrupt_media_path, fault_directory / "corrupt-output", None)
    except Exception as error:
        cases.append(_fault_result("corrupt_media", error))
    else:
        cases.append(_unexpected_fault_success("corrupt_media"))

    corrupt_audio_path = fault_directory / "corrupt-audio.wav"
    corrupt_audio_path.write_bytes(INVALID_MEDIA_CONTENT)
    transcriber = create_transcriber(
        _transcription_options(TranscriptionEngine.FASTER_WHISPER, "small"),
        models_path,
    )
    try:
        transcriber.transcribe(corrupt_audio_path, "fault-corrupt-audio")
    except Exception as error:
        cases.append(_fault_result("corrupt_audio_transcription", error))
    else:
        cases.append(_unexpected_fault_success("corrupt_audio_transcription"))
    finally:
        transcriber.close()

    summary = {
        "created_at": datetime.now(UTC).isoformat(),
        "expected_failures_handled": sum(
            case["status"] == "handled" for case in cases
        ),
        "total": len(cases),
        "cases": cases,
    }
    _write_json(output_path / "robustness" / "real-faults.json", summary)
    print(
        f"FAULTS_HANDLED {summary['expected_failures_handled']}/{summary['total']}",
        flush=True,
    )


def _fault_result(name: str, error: Exception) -> dict[str, object]:
    return {
        "name": name,
        "status": "handled",
        "error": f"{type(error).__name__}: {error}",
    }


def _unexpected_fault_success(name: str) -> dict[str, object]:
    return {
        "name": name,
        "status": "unexpected_success",
        "error": None,
    }


def snapshot_downloads(
    library_path: Path,
    output_path: Path,
    models_path: Path,
) -> None:
    """保存真实下载队列、媒体吞吐与模型落盘状态，便于复盘渠道体验。"""
    database_path = library_path / "openvideo.sqlite3"
    if not database_path.is_file():
        raise RuntimeError("视频库数据库不存在")
    connection = sqlite3.connect(f"{database_path.resolve().as_uri()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            """
            SELECT j.*, a.source_url, a.playback_path, a.source_platform
            FROM download_jobs j
            JOIN assets a ON a.asset_id = j.asset_id
            WHERE a.source_url LIKE ?
            ORDER BY j.created_at
            """,
            (f"%{GAMES101_SOURCE_ID}%",),
        ).fetchall()
        video_jobs = [
            _video_download_job(connection, library_path, dict(row))
            for row in rows
        ]
    finally:
        connection.close()

    model_installations = []
    for descriptor in TRANSCRIPTION_MODEL_CATALOG:
        resources = transcription_model_resources(descriptor, models_path)
        model_installations.append(
            {
                "model": _model_key(descriptor.engine, descriptor.model),
                "installed": is_transcription_model_installed(
                    descriptor,
                    models_path,
                ),
                "repositories": [resource.repository for resource in resources],
                "bytes_on_disk": sum(
                    _directory_size(resource.directory) for resource in resources
                ),
            }
        )

    download_directory = output_path / "downloads"
    _write_json(download_directory / "video-jobs.json", video_jobs)
    _write_json(
        download_directory / "model-installations.json",
        {
            "created_at": datetime.now(UTC).isoformat(),
            "policy": "ModelScope 官方源优先，Hugging Face 官方源失败回退",
            "models": model_installations,
        },
    )
    print(
        "DOWNLOAD_SNAPSHOT "
        f"video_jobs={len(video_jobs)} models={len(model_installations)}",
        flush=True,
    )


def run_formula_ocr(output_path: Path) -> None:
    """记录当前普通 OCR 对真实课程公式帧的输出形态与结构化能力。"""
    frame_directory = output_path / "formula" / "episode-02-frames"
    frame_paths = sorted(frame_directory.glob("*.jpg"))
    if not frame_paths:
        raise RuntimeError("没有可用于公式测试的关键帧")
    started = time.perf_counter()
    ocr_text = LocalOcrReader().read_frames(frame_paths) or ""
    result = {
        "created_at": datetime.now(UTC).isoformat(),
        "episode": 2,
        "source_start_seconds": 600,
        "source_end_seconds": 1080,
        "frame_count": len(frame_paths),
        "elapsed_seconds": time.perf_counter() - started,
        "expected_formulas": FORMULA_EXPECTATIONS,
        "expected_formula_count": len(FORMULA_EXPECTATIONS),
        "output_kind": "plain_text",
        "structured_latex_count": 0,
        "ocr_text": ocr_text,
    }
    _write_json(output_path / "formula" / "ocr-result.json", result)
    print(
        "FORMULA_OCR "
        f"frames={len(frame_paths)} structured_latex=0/{len(FORMULA_EXPECTATIONS)}",
        flush=True,
    )


async def resume_video_downloads(library_path: Path) -> None:
    """仅恢复 GAMES101 下载队列，避免同时唤醒资料库中的分析任务。"""
    library = MediaLibrary.open(library_path)
    try:
        manager = DownloadManager(
            library,
            load_settings(),
            DownloadAccountStore(),
        )
        assets = sorted(
            (
                asset
                for asset in library.list()
                if GAMES101_SOURCE_ID in asset.source_url
                and asset.status.value != "ready"
            ),
            key=lambda asset: _episode_from_url(asset.source_url),
        )
        completed = 0
        failed = 0
        for asset in assets:
            episode = _episode_from_url(asset.source_url)
            succeeded = False
            for attempt in range(1, MAX_VIDEO_DOWNLOAD_ATTEMPTS + 1):
                failed_jobs = [
                    job
                    for job in library.list_download_jobs()
                    if job.asset_id == asset.asset_id
                    and job.stage == DownloadStage.FAILED
                ]
                if not failed_jobs:
                    raise RuntimeError(f"第 {episode} 集没有可恢复的下载任务")
                latest_job = max(failed_jobs, key=lambda job: job.created_at)
                job = manager.retry(latest_job.job_id)
                manager.start(job.job_id)
                print(
                    f"VIDEO_DOWNLOAD_START episode={episode} attempt={attempt}",
                    flush=True,
                )
                previous_stage: DownloadStage | None = None
                while True:
                    current = manager.get(job.job_id)
                    if current is None:
                        raise RuntimeError(f"第 {episode} 集下载任务丢失")
                    if current.stage != previous_stage:
                        print(
                            "VIDEO_DOWNLOAD_STAGE "
                            f"episode={episode} stage={current.stage.value} "
                            f"progress={current.progress_percent:.1f}",
                            flush=True,
                        )
                        previous_stage = current.stage
                    if current.stage in {DownloadStage.COMPLETE, DownloadStage.FAILED}:
                        succeeded = current.stage == DownloadStage.COMPLETE
                        if not succeeded:
                            print(
                                "VIDEO_DOWNLOAD_RETRY "
                                f"episode={episode} error={current.error_message}",
                                flush=True,
                            )
                        break
                    await asyncio.sleep(DOWNLOAD_STATUS_POLL_SECONDS)
                if succeeded:
                    completed += 1
                    break
            if not succeeded:
                failed += 1
        print(
            f"VIDEO_DOWNLOADS_FINISHED complete={completed} failed={failed}",
            flush=True,
        )
    finally:
        library.close()


def _episode_from_url(source_url: str) -> int:
    episode_match = re.search(r"[?&]p=(\d+)", source_url)
    if episode_match is None:
        raise RuntimeError("GAMES101 地址缺少分集编号")
    return int(episode_match.group(1))


def _video_download_job(
    connection: sqlite3.Connection,
    library_path: Path,
    job: dict[str, object],
) -> dict[str, object]:
    events = connection.execute(
        """
        SELECT stage, progress_percent, created_at, error_message
        FROM download_events
        WHERE job_id = ?
        ORDER BY created_at
        """,
        (job["job_id"],),
    ).fetchall()
    event_values = [dict(event) for event in events]
    download_started_at = _first_event_time(event_values, "downloading")
    processing_started_at = _first_event_time(event_values, "processing")
    terminal_at = _first_terminal_event_time(event_values)
    download_seconds = _seconds_between(download_started_at, processing_started_at)
    processing_seconds = _seconds_between(processing_started_at, terminal_at)
    execution_started_at = next(
        (
            str(event["created_at"])
            for event in event_values
            if event["stage"] != "pending"
        ),
        None,
    )
    execution_seconds = _seconds_between(execution_started_at, terminal_at)
    playback_path = str(job.get("playback_path") or "")
    media_path = library_path / "assets" / str(job["asset_id"]) / playback_path
    media_bytes = media_path.stat().st_size if media_path.is_file() else None
    episode_match = re.search(r"[?&]p=(\d+)", str(job["source_url"]))
    return {
        "job_id": job["job_id"],
        "asset_id": job["asset_id"],
        "episode": int(episode_match.group(1)) if episode_match else None,
        "platform": job["source_platform"],
        "stage": job["stage"],
        "progress_percent": job["progress_percent"],
        "created_at": job["created_at"],
        "updated_at": job["updated_at"],
        "error_message": job["error_message"],
        "download_seconds": download_seconds,
        "processing_seconds": processing_seconds,
        "execution_seconds": execution_seconds,
        "media_bytes": media_bytes,
        "download_mbps": (
            media_bytes * 8 / download_seconds / 1_000_000
            if media_bytes is not None and download_seconds
            else None
        ),
    }


def _first_event_time(
    events: list[dict[str, object]],
    stage: str,
) -> str | None:
    return next(
        (str(event["created_at"]) for event in events if event["stage"] == stage),
        None,
    )


def _first_terminal_event_time(events: list[dict[str, object]]) -> str | None:
    terminal_stages = {"complete", "failed"}
    return next(
        (
            str(event["created_at"])
            for event in events
            if event["stage"] in terminal_stages
        ),
        None,
    )


def _seconds_between(start: str | None, end: str | None) -> float | None:
    if start is None or end is None:
        return None
    start_time = datetime.fromisoformat(start.replace("Z", "+00:00"))
    end_time = datetime.fromisoformat(end.replace("Z", "+00:00"))
    return max(0, (end_time - start_time).total_seconds())


def _directory_size(directory: Path) -> int:
    if not directory.is_dir():
        return 0
    return sum(path.stat().st_size for path in directory.rglob("*") if path.is_file())


def prepare_benchmark(library_path: Path, output_path: Path) -> None:
    assets = discover_games101_assets(library_path)
    if not assets:
        raise RuntimeError("视频库中没有已完成的 GAMES101 视频")
    output_path.mkdir(parents=True, exist_ok=True)
    reference_directory = output_path / "references"
    representative_directory = output_path / "audio" / "representative"
    reference_directory.mkdir(parents=True, exist_ok=True)
    representative_directory.mkdir(parents=True, exist_ok=True)

    prepared_cases: list[dict[str, object]] = []
    selected_assets = _select_representative_assets(assets)
    for asset in selected_assets:
        reference_path = reference_directory / f"episode-{asset.episode:02d}.json"
        if not reference_path.is_file():
            reference = extract_platform_subtitles(
                asset.source_url,
                reference_directory / f"episode-{asset.episode:02d}-download",
            )
            if reference is not None:
                _write_json(reference_path, reference.model_dump(mode="json"))

        clip_duration = min(
            REPRESENTATIVE_DURATION_SECONDS,
            max(1, asset.duration_seconds - REPRESENTATIVE_START_SECONDS),
        )
        clip_path = representative_directory / f"episode-{asset.episode:02d}.wav"
        if not clip_path.is_file():
            _extract_audio_clip(
                asset.media_path,
                clip_path,
                REPRESENTATIVE_START_SECONDS,
                clip_duration,
            )
        prepared_cases.append(
            {
                "case_id": f"representative-episode-{asset.episode:02d}",
                "episode": asset.episode,
                "title": asset.title,
                "audio_path": str(clip_path.resolve()),
                "source_start_seconds": REPRESENTATIVE_START_SECONDS,
                "duration_seconds": clip_duration,
                "reference_path": (
                    str(reference_path.resolve()) if reference_path.is_file() else None
                ),
            }
        )

    state_path = output_path / STATE_FILE_NAME
    previous_state = _read_json(state_path) if state_path.is_file() else {}
    _write_json(
        state_path,
        {
            "run_id": previous_state.get("run_id", f"benchmark-{uuid7().hex}"),
            "created_at": previous_state.get(
                "created_at", datetime.now(UTC).isoformat()
            ),
            "updated_at": datetime.now(UTC).isoformat(),
            "library_path": str(library_path.resolve()),
            "representative_cases": prepared_cases,
        },
    )
    print(f"PREPARED {len(prepared_cases)} representative cases", flush=True)


def download_models(models_path: Path, model_keys: list[str] | None) -> None:
    descriptors = list(TRANSCRIPTION_MODEL_CATALOG)
    if model_keys:
        requested_keys = set(model_keys)
        descriptors = [
            descriptor
            for descriptor in descriptors
            if _model_key(descriptor.engine, descriptor.model) in requested_keys
        ]
        missing = requested_keys - {
            _model_key(descriptor.engine, descriptor.model)
            for descriptor in descriptors
        }
        if missing:
            raise RuntimeError(f"未知模型：{', '.join(sorted(missing))}")

    for descriptor in descriptors:
        key = _model_key(descriptor.engine, descriptor.model)
        if is_transcription_model_installed(descriptor, models_path):
            print(f"DOWNLOAD_SKIP {key}", flush=True)
            continue
        print(f"DOWNLOAD_START {key}", flush=True)

        def report_progress(downloaded_bytes: int, total_bytes: int) -> None:
            print(
                f"DOWNLOAD_PROGRESS {key} {downloaded_bytes}/{total_bytes}",
                flush=True,
            )

        try:
            download_transcription_model(descriptor, models_path, report_progress)
        except Exception as error:
            print(f"DOWNLOAD_FAILED {key} {error}", flush=True)
            continue
        print(f"DOWNLOAD_COMPLETE {key}", flush=True)


def run_benchmark(
    library_path: Path,
    output_path: Path,
    models_path: Path,
    model_key: str,
    scope: str,
) -> None:
    engine, model = _parse_model_key(model_key)
    descriptor = find_transcription_model(engine, model)
    if descriptor is None:
        raise RuntimeError(f"未知模型：{model_key}")
    if not is_transcription_model_installed(descriptor, models_path):
        raise RuntimeError(f"模型尚未安装：{model_key}")
    if not (output_path / STATE_FILE_NAME).is_file():
        prepare_benchmark(library_path, output_path)

    if scope == "representative":
        cases = _representative_cases(output_path)
    elif scope == "short-reference":
        cases = [_short_reference_case(library_path, output_path)]
    else:
        cases = _qwen_ready_cases(library_path, output_path)
    options = _transcription_options(engine, model)
    transcriber = create_transcriber(options, models_path)
    try:
        for case in cases:
            _run_case(transcriber, output_path, model_key, scope, case)
    finally:
        transcriber.close()


def build_report(output_path: Path) -> None:
    result_paths = sorted((output_path / "results").glob("*/*/*.json"))
    results = [
        _refresh_timing_metrics(output_path, path, _read_json(path))
        for path in result_paths
    ]
    metrics = [result for result in results if result.get("model")]
    _write_json(output_path / RESULTS_FILE_NAME, metrics)
    _write_metrics_csv(output_path / RESULTS_CSV_FILE_NAME, metrics)

    successful = [result for result in metrics if result["status"] == SUCCESS_STATUS]
    failures = [result for result in metrics if result["status"] == FAILED_STATUS]
    lines = [
        "# OpenVideo ASR 夜间基准报告",
        "",
        f"- 更新时间：{datetime.now(UTC).isoformat()}",
        f"- 成功组合：{len(successful)}",
        f"- 失败组合：{len(failures)}",
        "- CER/WER 只使用公开 AI 字幕作为整集代理参考，不是人工金标。",
        "- 无参考片段不计算 CER/WER，禁止用模型互相比对冒充准确率。",
        "- RTF 是整夜并行负载下的实际表现，不是单模型独占资源峰值。",
        "",
        "## 模型汇总",
        "",
        "| 模型 | 范围 | 成功/总数 | 平均 RTF | 代理 CER | 术语覆盖 | 时间覆盖率 | 最大空缺秒数 | 最长字幕秒数 |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    model_scopes = sorted(
        {(str(result["model"]), str(result["scope"])) for result in metrics}
    )
    for model, scope in model_scopes:
        model_results = [
            result
            for result in metrics
            if result["model"] == model and result["scope"] == scope
        ]
        model_success = [
            result for result in model_results if result["status"] == SUCCESS_STATUS
        ]
        lines.append(
            "| {model} | {scope} | {success}/{total} | {rtf} | {cer} | {terms} | {coverage} | {gap} | {maximum} |".format(
                model=model,
                scope=scope,
                success=len(model_success),
                total=len(model_results),
                rtf=_average_metric(model_success, "realtime_factor"),
                cer=_average_metric(model_success, "proxy_cer"),
                terms=_average_metric(model_success, "proxy_glossary_recall"),
                coverage=_average_metric(model_success, "timeline_coverage_ratio"),
                gap=_maximum_metric(model_success, "max_timeline_gap_seconds"),
                maximum=_maximum_metric(model_success, "max_segment_seconds"),
            )
        )
    _append_download_report(lines, output_path)
    _append_robustness_report(lines, output_path)
    _append_formula_report(lines, output_path)
    if failures:
        lines.extend(["", "## 失败", ""])
        for result in failures:
            lines.append(
                f"- `{result['model']}` / `{result['case_id']}`：{result['error']}"
            )
    (output_path / REPORT_FILE_NAME).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"REPORT {output_path / REPORT_FILE_NAME}", flush=True)


def _append_download_report(lines: list[str], output_path: Path) -> None:
    jobs_path = output_path / "downloads" / "video-jobs.json"
    models_path = output_path / "downloads" / "model-installations.json"
    if not jobs_path.is_file() and not models_path.is_file():
        return
    lines.extend(["", "## 下载实测", ""])
    if jobs_path.is_file():
        jobs = json.loads(jobs_path.read_text(encoding="utf-8"))
        completed = [job for job in jobs if job["stage"] == "complete"]
        failed = [job for job in jobs if job["stage"] == "failed"]
        rates = sorted(
            float(job["download_mbps"])
            for job in completed
            if job.get("download_mbps") is not None
        )
        processing_times = sorted(
            float(job["processing_seconds"])
            for job in completed
            if job.get("processing_seconds") is not None
        )
        ready_episodes = {job["episode"] for job in completed}
        failed_episodes = {job["episode"] for job in failed}
        recovered_episodes = ready_episodes & failed_episodes
        unresolved_episodes = failed_episodes - ready_episodes
        lines.append(
            f"- GAMES101：已完成 {len(ready_episodes)}/23 集；"
            f"历史失败/中断 {len(failed)} 条，已恢复 {len(recovered_episodes)} 集，"
            f"未恢复 {len(unresolved_episodes)} 集。"
        )
        if rates:
            median_rate = rates[len(rates) // 2]
            lines.append(
                "- Bilibili 媒体下载阶段："
                f"中位 {median_rate:.2f} Mbps，范围 {min(rates):.2f}–{max(rates):.2f} Mbps。"
            )
        if processing_times:
            median_processing = processing_times[len(processing_times) // 2]
            lines.append(
                "- 下载后的媒体校验与预览生成："
                f"中位 {median_processing:.1f} 秒；该阶段界面已显示 100%，容易被误认为卡住。"
            )
    if models_path.is_file():
        model_snapshot = _read_json(models_path)
        models = model_snapshot["models"]
        installed = sum(model["installed"] for model in models)
        lines.append(
            f"- 转录模型：{installed}/{len(models)} 完整安装；{model_snapshot['policy']}。"
        )


def _append_robustness_report(lines: list[str], output_path: Path) -> None:
    robustness_path = output_path / "robustness"
    real_faults_path = robustness_path / "real-faults.json"
    pytest_path = robustness_path / "pytest-results.xml"
    web_tests_path = robustness_path / "web-transcript-tests.xml"
    cuda_fault_path = robustness_path / "faster-whisper-small-cuda-missing-cublas.json"
    evidence_paths = (
        real_faults_path,
        pytest_path,
        web_tests_path,
        cuda_fault_path,
    )
    if not any(path.is_file() for path in evidence_paths):
        return
    lines.extend(["", "## 鲁棒性", ""])
    if pytest_path.is_file():
        root = ElementTree.parse(pytest_path).getroot()
        suite = root.find("testsuite")
        if suite is not None:
            lines.append(
                "- 自动故障与恢复测试："
                f"{suite.attrib.get('tests', '0')} 项，"
                f"失败 {suite.attrib.get('failures', '0')}，"
                f"错误 {suite.attrib.get('errors', '0')}。"
            )
    if web_tests_path.is_file():
        root = ElementTree.parse(web_tests_path).getroot()
        lines.append(
            "- 转录查看与编辑前端测试："
            f"{root.attrib.get('tests', '0')} 项，"
            f"失败 {root.attrib.get('failures', '0')}，"
            f"错误 {root.attrib.get('errors', '0')}。"
        )
    if real_faults_path.is_file():
        real_faults = _read_json(real_faults_path)
        lines.append(
            "- 真实坏输入隔离："
            f"{real_faults['expected_failures_handled']}/{real_faults['total']} 正确拦截。"
        )
    if cuda_fault_path.is_file():
        cuda_fault = _read_json(cuda_fault_path)
        lines.append(f"- CUDA 依赖缺失：已稳定失败并记录；`{cuda_fault['error']}`")


def _append_formula_report(lines: list[str], output_path: Path) -> None:
    formula_path = output_path / "formula" / "ocr-result.json"
    if not formula_path.is_file():
        return
    formula_result = _read_json(formula_path)
    lines.extend(
        [
            "",
            "## 数学公式",
            "",
            "- 真实课程公式帧："
            f"{formula_result['frame_count']} 帧，处理 {formula_result['elapsed_seconds']:.2f} 秒。",
            "- 结构化 LaTeX："
            f"{formula_result['structured_latex_count']}/{formula_result['expected_formula_count']}；"
            "当前普通 OCR 仅返回纯文本，向量箭头、范数、根号和分式均有丢失。",
        ]
    )


def discover_games101_assets(library_path: Path) -> list[VideoAsset]:
    assets_path = library_path / "assets"
    discovered: list[VideoAsset] = []
    for metadata_path in assets_path.glob("*/meta.json"):
        metadata = _read_json(metadata_path)
        source = metadata.get("source") or {}
        source_url = str(source.get("url") or "")
        if GAMES101_SOURCE_ID not in source_url or metadata.get("status") != "ready":
            continue
        episode_match = re.search(r"[?&]p=(\d+)", source_url)
        playback_path = str(metadata.get("playback_path") or "")
        video = metadata.get("video") or {}
        if not episode_match or not playback_path or not video.get("duration_seconds"):
            continue
        media_path = metadata_path.parent / Path(playback_path)
        if not media_path.is_file():
            continue
        discovered.append(
            VideoAsset(
                episode=int(episode_match.group(1)),
                asset_id=str(metadata["asset_id"]),
                title=str(metadata["title"]),
                source_url=source_url,
                media_path=media_path,
                duration_seconds=float(video["duration_seconds"]),
            )
        )
    return sorted(discovered, key=lambda asset: asset.episode)


def _select_representative_assets(assets: list[VideoAsset]) -> list[VideoAsset]:
    by_episode = {asset.episode: asset for asset in assets}
    selected = [
        by_episode[episode]
        for episode in REPRESENTATIVE_EPISODES
        if episode in by_episode
    ]
    if len(selected) == len(REPRESENTATIVE_EPISODES):
        return selected
    for asset in assets:
        if asset not in selected:
            selected.append(asset)
        if len(selected) == len(REPRESENTATIVE_EPISODES):
            break
    return selected


def _representative_cases(output_path: Path) -> list[BenchmarkCase]:
    state = _read_json(output_path / STATE_FILE_NAME)
    return [_case_from_dict(case) for case in state["representative_cases"]]


def _qwen_ready_cases(library_path: Path, output_path: Path) -> list[BenchmarkCase]:
    cases: list[BenchmarkCase] = []
    full_audio_directory = output_path / "audio" / "full"
    reference_directory = output_path / "references"
    full_audio_directory.mkdir(parents=True, exist_ok=True)
    for asset in discover_games101_assets(library_path):
        audio_path = full_audio_directory / f"episode-{asset.episode:02d}.wav"
        if not audio_path.is_file():
            _extract_audio_clip(asset.media_path, audio_path, 0, asset.duration_seconds)
        reference_path = reference_directory / f"episode-{asset.episode:02d}.json"
        cases.append(
            BenchmarkCase(
                case_id=f"full-episode-{asset.episode:02d}",
                episode=asset.episode,
                title=asset.title,
                audio_path=audio_path,
                source_start_seconds=0,
                duration_seconds=asset.duration_seconds,
                reference_path=reference_path if reference_path.is_file() else None,
            )
        )
    return cases


def _short_reference_case(
    library_path: Path,
    output_path: Path,
) -> BenchmarkCase:
    asset = next(
        (
            candidate
            for candidate in discover_games101_assets(library_path)
            if candidate.episode == SHORT_REFERENCE_EPISODE
        ),
        None,
    )
    if asset is None:
        raise RuntimeError("GAMES101 短参考集尚未就绪")
    audio_path = (
        output_path / "audio" / "full" / f"episode-{asset.episode:02d}.wav"
    )
    if not audio_path.is_file():
        _extract_audio_clip(asset.media_path, audio_path, 0, asset.duration_seconds)
    return BenchmarkCase(
        case_id=f"short-reference-episode-{asset.episode:02d}",
        episode=asset.episode,
        title=asset.title,
        audio_path=audio_path,
        source_start_seconds=0,
        duration_seconds=asset.duration_seconds,
        reference_path=None,
    )


def _run_case(
    transcriber: object,
    output_path: Path,
    model_key: str,
    scope: str,
    case: BenchmarkCase,
) -> None:
    model_directory_name = _model_directory_name(model_key)
    result_path = (
        output_path
        / "results"
        / model_directory_name
        / scope
        / f"{case.case_id}.json"
    )
    transcript_path = (
        output_path
        / "transcripts"
        / model_directory_name
        / scope
        / f"{case.case_id}.json"
    )
    if result_path.is_file():
        print(f"RUN_SKIP {model_key} {case.case_id}", flush=True)
        return
    result_path.parent.mkdir(parents=True, exist_ok=True)
    transcript_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"RUN_START {model_key} {case.case_id}", flush=True)
    started_at = datetime.now(UTC)
    started = time.perf_counter()
    sampler = ResourceSampler()
    try:
        with sampler:
            transcript = transcriber.transcribe(case.audio_path, case.case_id)
        elapsed_seconds = time.perf_counter() - started
        _write_json(transcript_path, transcript.model_dump(mode="json"))
        metrics = _transcript_metrics(transcript, case, elapsed_seconds)
        result = {
            "model": model_key,
            "scope": scope,
            "case_id": case.case_id,
            "episode": case.episode,
            "title": case.title,
            "status": SUCCESS_STATUS,
            "started_at": started_at.isoformat(),
            "completed_at": datetime.now(UTC).isoformat(),
            "peak_rss_bytes": sampler.peak_rss_bytes,
            "peak_gpu_memory_mib": sampler.peak_gpu_memory_mib,
            **metrics,
        }
    except Exception as error:
        result = {
            "model": model_key,
            "scope": scope,
            "case_id": case.case_id,
            "episode": case.episode,
            "title": case.title,
            "status": FAILED_STATUS,
            "started_at": started_at.isoformat(),
            "completed_at": datetime.now(UTC).isoformat(),
            "elapsed_seconds": time.perf_counter() - started,
            "peak_rss_bytes": sampler.peak_rss_bytes,
            "peak_gpu_memory_mib": sampler.peak_gpu_memory_mib,
            "error": f"{type(error).__name__}: {error}",
        }
    _write_json(result_path, result)
    print(
        f"RUN_{result['status'].upper()} {model_key} {case.case_id}",
        flush=True,
    )


def _transcript_metrics(
    transcript: Transcript,
    case: BenchmarkCase,
    elapsed_seconds: float,
) -> dict[str, object]:
    segment_durations = [
        segment.end_seconds - segment.start_seconds for segment in transcript.segments
    ]
    segment_text_lengths = [len(segment.text) for segment in transcript.segments]
    text = "".join(segment.text for segment in transcript.segments)
    reference_text = _reference_text(case)
    proxy_cer = _error_rate(
        _normalize_characters(reference_text),
        _normalize_characters(text),
    )
    proxy_wer = _error_rate(_word_tokens(reference_text), _word_tokens(text))
    return {
        "audio_duration_seconds": case.duration_seconds,
        "elapsed_seconds": elapsed_seconds,
        "realtime_factor": elapsed_seconds / case.duration_seconds,
        "language": transcript.language,
        "segment_count": len(transcript.segments),
        "text_characters": len(text),
        "average_segment_seconds": _average(segment_durations),
        "max_segment_seconds": max(segment_durations, default=0),
        "average_segment_characters": _average(segment_text_lengths),
        "max_segment_characters": max(segment_text_lengths, default=0),
        "invalid_timestamps": sum(
            segment.end_seconds <= segment.start_seconds
            for segment in transcript.segments
        ),
        "proxy_cer": proxy_cer,
        "proxy_wer": proxy_wer,
        "reference_available": bool(reference_text),
        **_timing_metrics(transcript, case.duration_seconds),
    }


def _timing_metrics(
    transcript: Transcript,
    audio_duration_seconds: float,
) -> dict[str, object]:
    ordered_segments = sorted(
        transcript.segments,
        key=lambda segment: (segment.start_seconds, segment.end_seconds),
    )
    gaps: list[float] = []
    covered_seconds = 0.0
    previous_end_seconds = 0.0
    for segment in ordered_segments:
        start_seconds = min(max(segment.start_seconds, 0), audio_duration_seconds)
        end_seconds = min(max(segment.end_seconds, 0), audio_duration_seconds)
        if start_seconds > previous_end_seconds:
            gaps.append(start_seconds - previous_end_seconds)
        uncovered_start_seconds = max(start_seconds, previous_end_seconds)
        covered_seconds += max(0, end_seconds - uncovered_start_seconds)
        previous_end_seconds = max(previous_end_seconds, end_seconds)
    if previous_end_seconds < audio_duration_seconds:
        gaps.append(audio_duration_seconds - previous_end_seconds)
    return {
        "timeline_coverage_ratio": (
            covered_seconds / audio_duration_seconds if audio_duration_seconds else 0
        ),
        "max_timeline_gap_seconds": max(gaps, default=0),
        "timeline_gaps_over_10_seconds": sum(gap > 10 for gap in gaps),
    }


def _refresh_timing_metrics(
    output_path: Path,
    result_path: Path,
    result: dict[str, object],
) -> dict[str, object]:
    if result.get("status") != SUCCESS_STATUS:
        return result
    model_key = str(result["model"])
    scope = str(result["scope"])
    case_id = str(result["case_id"])
    transcript_path = (
        output_path
        / "transcripts"
        / _model_directory_name(model_key)
        / scope
        / f"{case_id}.json"
    )
    if not transcript_path.is_file():
        return result
    transcript = Transcript.model_validate(_read_json(transcript_path))
    result.update(
        _timing_metrics(transcript, float(result["audio_duration_seconds"]))
    )
    external_reference_path = (
        output_path
        / "references"
        / "external"
        / f"episode-{int(result['episode']):02d}.txt"
    )
    reference_scopes = {"qwen-ready", "short-reference"}
    if scope in reference_scopes and external_reference_path.is_file():
        hypothesis_text = "".join(
            segment.text for segment in transcript.segments
        )
        reference_text = external_reference_path.read_text(encoding="utf-8")
        result.update(
            {
                "proxy_cer": _error_rate(
                    _normalize_characters(reference_text),
                    _normalize_characters(hypothesis_text),
                ),
                "proxy_wer": _error_rate(
                    _word_tokens(reference_text),
                    _word_tokens(hypothesis_text),
                ),
                "reference_available": True,
                "reference_kind": EXTERNAL_REFERENCE_KIND,
                **_glossary_metrics(reference_text, hypothesis_text),
            }
        )
    _write_json(result_path, result)
    return result


def _plain_subtitle_text(path: Path) -> str:
    lines: list[str] = []
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.isdigit() or "-->" in line:
            continue
        lines.append(line)
    return "\n".join(lines)


def _glossary_metrics(
    reference_text: str,
    hypothesis_text: str,
) -> dict[str, object]:
    normalized_reference = reference_text.lower()
    normalized_hypothesis = hypothesis_text.lower()
    expected = [
        aliases
        for aliases in PROFESSIONAL_TERM_ALIASES
        if any(alias in normalized_reference for alias in aliases)
    ]
    recognized = [
        aliases[0]
        for aliases in expected
        if any(alias in normalized_hypothesis for alias in aliases)
    ]
    missing = [aliases[0] for aliases in expected if aliases[0] not in recognized]
    return {
        "proxy_glossary_expected": len(expected),
        "proxy_glossary_recognized": len(recognized),
        "proxy_glossary_recall": len(recognized) / len(expected) if expected else None,
        "proxy_glossary_missing": missing,
    }


def _reference_text(case: BenchmarkCase) -> str:
    if case.reference_path is None or not case.reference_path.is_file():
        return ""
    transcript = Transcript.model_validate(_read_json(case.reference_path))
    source_end_seconds = case.source_start_seconds + case.duration_seconds
    return "".join(
        segment.text
        for segment in transcript.segments
        if segment.end_seconds > case.source_start_seconds
        and segment.start_seconds < source_end_seconds
    )


def _normalize_characters(text: str) -> list[str]:
    return list(re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "", text).lower())


def _word_tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+|[\u4e00-\u9fff]", text.lower())


def _error_rate(reference: list[str], hypothesis: list[str]) -> float | None:
    if not reference:
        return None
    return Levenshtein.distance(reference, hypothesis) / len(reference)


def _transcription_options(
    engine: TranscriptionEngine,
    model: str,
) -> TranscriptionOptions:
    if engine == TranscriptionEngine.FASTER_WHISPER:
        return TranscriptionOptions(
            engine=engine,
            model=model,
            language="zh",
            device=TranscriptionDevice.CPU,
            compute_type=TranscriptionComputeType.INT8,
        )
    if engine == TranscriptionEngine.SENSEVOICE:
        return TranscriptionOptions(
            engine=engine,
            model=model,
            language="zh",
            device=TranscriptionDevice.AUTO,
            compute_type=TranscriptionComputeType.AUTO,
        )
    return TranscriptionOptions(
        engine=engine,
        model=model,
        language="zh",
        device=TranscriptionDevice.CUDA,
        compute_type=TranscriptionComputeType.FLOAT16,
    )


def _extract_audio_clip(
    media_path: Path,
    output_path: Path,
    start_seconds: float,
    duration_seconds: float,
) -> None:
    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        raise RuntimeError("未找到 ffmpeg")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        ffmpeg_path,
        "-y",
        "-ss",
        str(start_seconds),
        "-i",
        str(media_path),
        "-t",
        str(duration_seconds),
        "-vn",
        "-ac",
        str(AUDIO_CHANNELS),
        "-ar",
        str(AUDIO_SAMPLE_RATE),
        "-c:a",
        "pcm_s16le",
        str(output_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0 or not output_path.is_file():
        raise RuntimeError(result.stderr.strip() or "音频提取失败")


def _gpu_memory_used_mib() -> int | None:
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=memory.used",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=2,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    first_line = result.stdout.strip().splitlines()[0]
    return int(first_line) if first_line.isdigit() else None


def _parse_model_key(model_key: str) -> tuple[TranscriptionEngine, str]:
    try:
        engine_value, model = model_key.split(MODEL_KEY_SEPARATOR, maxsplit=1)
        return TranscriptionEngine(engine_value), model
    except (ValueError, KeyError) as error:
        raise RuntimeError(f"模型格式无效：{model_key}") from error


def _model_key(engine: TranscriptionEngine, model: str) -> str:
    return f"{engine.value}{MODEL_KEY_SEPARATOR}{model}"


def _model_directory_name(model_key: str) -> str:
    """Windows 路径不允许冒号，因此测试目录使用无歧义的双下划线分隔。"""
    return model_key.replace(MODEL_KEY_SEPARATOR, "__")


def _case_from_dict(value: dict[str, object]) -> BenchmarkCase:
    reference_value = value.get("reference_path")
    return BenchmarkCase(
        case_id=str(value["case_id"]),
        episode=int(value["episode"]),
        title=str(value["title"]),
        audio_path=Path(str(value["audio_path"])),
        source_start_seconds=float(value["source_start_seconds"]),
        duration_seconds=float(value["duration_seconds"]),
        reference_path=Path(str(reference_value)) if reference_value else None,
    )


def _write_metrics_csv(path: Path, metrics: list[dict[str, object]]) -> None:
    fields = (
        "model",
        "scope",
        "case_id",
        "episode",
        "status",
        "audio_duration_seconds",
        "elapsed_seconds",
        "realtime_factor",
        "proxy_cer",
        "proxy_wer",
        "proxy_glossary_recall",
        "reference_kind",
        "segment_count",
        "max_segment_seconds",
        "max_segment_characters",
        "timeline_coverage_ratio",
        "max_timeline_gap_seconds",
        "timeline_gaps_over_10_seconds",
        "peak_rss_bytes",
        "peak_gpu_memory_mib",
        "error",
    )
    with path.open("w", encoding="utf-8-sig", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(metrics)


def _read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(f"{path.suffix}.tmp")
    temporary_path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temporary_path.replace(path)


def _average(values: list[float] | list[int]) -> float:
    return sum(values) / len(values) if values else 0


def _average_metric(results: list[dict[str, object]], field: str) -> str:
    values = [float(result[field]) for result in results if result.get(field) is not None]
    return f"{_average(values):.4f}" if values else "—"


def _maximum_metric(results: list[dict[str, object]], field: str) -> str:
    values = [float(result[field]) for result in results if result.get(field) is not None]
    return f"{max(values):.2f}" if values else "—"


if __name__ == "__main__":
    main()
