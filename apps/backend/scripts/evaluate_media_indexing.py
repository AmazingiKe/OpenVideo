"""只读视频，对照逐帧抽取、批量抽取和局部场景扫描；所有帧存入临时目录。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
from statistics import median
import subprocess
from tempfile import TemporaryDirectory
from time import perf_counter

from PIL import Image, ImageChops

from openvideo.tools.frames import extract_frames
from openvideo.tools.media import probe_media, resolve_tool
from openvideo.tools.scenes import (
    LOCAL_SCENE_THRESHOLDS,
    SCENE_SCAN_TIMEOUT_SECONDS,
    SCENE_SCAN_WIDTH,
    _deduplicate_times,
    refine_scene_candidates,
)


FRAME_COUNT = 12
LOCAL_WINDOW_SECONDS = 30
LOCAL_TARGET_COUNT = 5
REPEAT_COUNT = 3
BASELINE_TIME_PATTERN = re.compile(r"pts_time:(\d+(?:\.\d+)?)")


def baseline_scene_candidates(media: Path, ffmpeg: str, start: float, end: float):
    """保留本次重构前的三阈值重复扫描策略，用于比较候选一致性和耗时。"""
    duration = end - start
    detected = []
    scans = 0
    for threshold in LOCAL_SCENE_THRESHOLDS:
        result = subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-skip_frame",
                "nokey",
                "-ss",
                str(start),
                "-i",
                str(media),
                "-t",
                str(duration),
                "-an",
                "-vf",
                f"scale={SCENE_SCAN_WIDTH}:-1,select='gt(scene,{threshold})',showinfo",
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
            check=True,
            text=True,
            timeout=SCENE_SCAN_TIMEOUT_SECONDS,
        )
        scans += 1
        detected = [
            start + seconds
            for value in BASELINE_TIME_PATTERN.findall(result.stderr)
            if 0 <= (seconds := float(value)) <= duration
        ]
        if len(detected) >= LOCAL_TARGET_COUNT - 1:
            break
    uniform = [
        start + duration * position / (LOCAL_TARGET_COUNT + 1)
        for position in range(1, LOCAL_TARGET_COUNT + 1)
    ]
    candidates = _deduplicate_times([*detected, *uniform], duration)
    if len(candidates) > LOCAL_TARGET_COUNT:
        indexes = {
            round(index * (len(candidates) - 1) / (LOCAL_TARGET_COUNT - 1))
            for index in range(LOCAL_TARGET_COUNT)
        }
        candidates = [candidates[index] for index in sorted(indexes)]
    return candidates, scans


def evaluate(media: Path, *, repeats: int) -> dict[str, object]:
    ffmpeg = resolve_tool(None, "ffmpeg")
    probe = probe_media(media, None)
    duration = probe.duration_seconds
    if ffmpeg is None or duration is None or duration <= 0 or repeats <= 0:
        raise ValueError("需要有效视频、FFmpeg/FFprobe 和正数重复次数")
    points = [duration * (index + 0.5) / FRAME_COUNT for index in range(FRAME_COUNT)]
    extraction_times = {"single": [], "batch": []}
    maximum_pixel_difference = 0
    with TemporaryDirectory(prefix="openvideo-media-evaluation-") as temporary:
        directory = Path(temporary)
        for repeat in range(repeats):
            frame_sets = {}
            modes = ("single", "batch") if repeat % 2 == 0 else ("batch", "single")
            for mode in modes:
                output = directory / f"{repeat}-{mode}"
                started = perf_counter()
                if mode == "single":
                    paths = [
                        extract_frames(media, [seconds], output / str(index), ffmpeg)[0]
                        for index, seconds in enumerate(points)
                    ]
                else:
                    paths = extract_frames(media, points, output, ffmpeg)
                extraction_times[mode].append(perf_counter() - started)
                frame_sets[mode] = paths
            for before, after in zip(
                frame_sets["single"], frame_sets["batch"], strict=True
            ):
                with Image.open(before) as expected, Image.open(after) as actual:
                    difference = ImageChops.difference(
                        expected.convert("RGB"), actual.convert("RGB")
                    )
                    maximum_pixel_difference = max(
                        maximum_pixel_difference,
                        *(channel[1] for channel in difference.getextrema()),
                    )
    windows = []
    window_duration = min(LOCAL_WINDOW_SECONDS, duration)
    for fraction in (0.1, 0.45, 0.8):
        start = (duration - window_duration) * fraction
        end = start + window_duration
        timings = {"baseline": [], "single_scan": []}
        candidates_equal = True
        scan_counts = []
        for repeat in range(repeats):
            modes = (
                ("baseline", "single_scan")
                if repeat % 2 == 0
                else ("single_scan", "baseline")
            )
            candidates = {}
            for mode in modes:
                started = perf_counter()
                if mode == "baseline":
                    candidates[mode], scans = baseline_scene_candidates(
                        media, ffmpeg, start, end
                    )
                    scan_counts.append(scans)
                else:
                    candidates[mode] = refine_scene_candidates(
                        media, start, end, LOCAL_TARGET_COUNT, ffmpeg
                    )
                timings[mode].append(perf_counter() - started)
            candidates_equal = (
                candidates_equal and candidates["baseline"] == candidates["single_scan"]
            )
        windows.append(
            {
                "start_seconds": round(start, 3),
                "end_seconds": round(end, 3),
                "baseline_scan_counts": scan_counts,
                "candidates_equal": candidates_equal,
                "median_seconds": {
                    mode: round(median(values), 4) for mode, values in timings.items()
                },
            }
        )
    return {
        "duration_seconds": duration,
        "width": probe.width,
        "height": probe.height,
        "video_codec": probe.video_codec,
        "repeats": repeats,
        "extraction": {
            "frame_count": FRAME_COUNT,
            "maximum_pixel_difference": maximum_pixel_difference,
            "median_seconds": {
                mode: round(median(values), 4)
                for mode, values in extraction_times.items()
            },
            "runs_seconds": extraction_times,
        },
        "local_scene_windows": windows,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("media", type=Path)
    parser.add_argument("--repeats", type=int, default=REPEAT_COUNT)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    report = evaluate(arguments.media, repeats=arguments.repeats)
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False))
