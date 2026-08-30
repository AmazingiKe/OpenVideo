"""在调用在线视觉模型前剔除无信息、模糊与近重复候选帧。"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import Image, UnidentifiedImageError


QUALITY_SCAN_WIDTH = 96
QUALITY_SCAN_HEIGHT = 54
DARK_MEAN_THRESHOLD = 12
BRIGHT_MEAN_THRESHOLD = 245
CONTRAST_VARIANCE_THRESHOLD = 28
EDGE_VARIANCE_THRESHOLD = 18
DUPLICATE_HASH_DISTANCE = 5


@dataclass(frozen=True)
class QualifiedFrame:
    path: Path
    seconds: float
    quality_score: float


def filter_candidate_frames(
    frame_paths: list[Path],
    time_points: list[float],
) -> list[QualifiedFrame]:
    """保留时间映射稳定的有效帧，质量不足只影响当前候选。"""

    if len(frame_paths) != len(time_points):
        raise ValueError("候选帧与时间点数量必须一致")
    accepted: list[QualifiedFrame] = []
    hashes: list[int] = []
    for path, seconds in zip(frame_paths, time_points, strict=True):
        inspected = _inspect_frame(path)
        if inspected is None:
            continue
        mean, contrast_variance, edge_variance, perceptual_hash = inspected
        if mean < DARK_MEAN_THRESHOLD or mean > BRIGHT_MEAN_THRESHOLD:
            continue
        if contrast_variance < CONTRAST_VARIANCE_THRESHOLD:
            continue
        if edge_variance < EDGE_VARIANCE_THRESHOLD:
            continue
        if any(
            (perceptual_hash ^ existing_hash).bit_count() < DUPLICATE_HASH_DISTANCE
            for existing_hash in hashes
        ):
            continue
        hashes.append(perceptual_hash)
        quality_score = min(
            1.0,
            0.45 * contrast_variance / 900 + 0.55 * edge_variance / 1_800,
        )
        accepted.append(
            QualifiedFrame(
                path=path,
                seconds=seconds,
                quality_score=round(quality_score, 6),
            )
        )
    return accepted


def _inspect_frame(path: Path) -> tuple[float, float, float, int] | None:
    try:
        with Image.open(path) as image:
            grayscale = image.convert("L").resize(
                (QUALITY_SCAN_WIDTH, QUALITY_SCAN_HEIGHT)
            )
            pixels = list(grayscale.get_flattened_data())
    except (OSError, UnidentifiedImageError):
        return None
    mean = sum(pixels) / len(pixels)
    contrast_variance = sum((value - mean) ** 2 for value in pixels) / len(pixels)
    edge_values = []
    for y in range(1, QUALITY_SCAN_HEIGHT - 1):
        row = y * QUALITY_SCAN_WIDTH
        for x in range(1, QUALITY_SCAN_WIDTH - 1):
            index = row + x
            laplacian = (
                4 * pixels[index]
                - pixels[index - 1]
                - pixels[index + 1]
                - pixels[index - QUALITY_SCAN_WIDTH]
                - pixels[index + QUALITY_SCAN_WIDTH]
            )
            edge_values.append(laplacian)
    edge_mean = sum(edge_values) / len(edge_values)
    edge_variance = sum((value - edge_mean) ** 2 for value in edge_values) / len(
        edge_values
    )
    return mean, contrast_variance, edge_variance, _difference_hash(pixels)


def _difference_hash(pixels: list[int]) -> int:
    hash_value = 0
    sample_width = 9
    sample_height = 8
    for y in range(sample_height):
        source_y = round(y * (QUALITY_SCAN_HEIGHT - 1) / (sample_height - 1))
        for x in range(sample_width - 1):
            left_x = round(x * (QUALITY_SCAN_WIDTH - 1) / (sample_width - 1))
            right_x = round((x + 1) * (QUALITY_SCAN_WIDTH - 1) / (sample_width - 1))
            left = pixels[source_y * QUALITY_SCAN_WIDTH + left_x]
            right = pixels[source_y * QUALITY_SCAN_WIDTH + right_x]
            hash_value = (hash_value << 1) | int(left > right)
    return hash_value
