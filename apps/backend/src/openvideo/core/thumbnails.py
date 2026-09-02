import math
from dataclasses import dataclass

MAXIMUM_STORYBOARD_TILE_WIDTH = 640
MAXIMUM_STORYBOARD_TILE_HEIGHT = 360
SPRITE_COLUMNS = 10
STORYBOARD_INTERVAL_SECONDS = 5
MAXIMUM_STORYBOARD_TILES = 120
SPRITE_FILE_NAME = "scrub-storyboard.jpg"


@dataclass(frozen=True)
class ThumbnailStoryboard:
    sprite_path: str
    tile_width: int
    tile_height: int
    interval_seconds: float
    columns: int
    total_tiles: int


@dataclass(frozen=True)
class ThumbnailTile:
    start_time: float
    x: int
    y: int


def build_thumbnail_storyboard(
    duration_seconds: float | None,
    source_width: int | None = None,
    source_height: int | None = None,
) -> ThumbnailStoryboard | None:
    """为不支持 WebCodecs 的浏览器规划有上限的响应式预览拼板。"""
    if not duration_seconds or duration_seconds <= 0:
        return None
    uncapped_total_tiles = int(duration_seconds // STORYBOARD_INTERVAL_SECONDS) + 1
    total_tiles = min(uncapped_total_tiles, MAXIMUM_STORYBOARD_TILES)
    interval_seconds = (
        STORYBOARD_INTERVAL_SECONDS
        if total_tiles == uncapped_total_tiles
        else duration_seconds / (total_tiles - 1)
    )
    tile_width, tile_height = storyboard_tile_dimensions(
        source_width,
        source_height,
    )
    return ThumbnailStoryboard(
        sprite_path=SPRITE_FILE_NAME,
        tile_width=tile_width,
        tile_height=tile_height,
        interval_seconds=interval_seconds,
        columns=SPRITE_COLUMNS,
        total_tiles=total_tiles,
    )


def storyboard_tile_dimensions(
    source_width: int | None,
    source_height: int | None,
) -> tuple[int, int]:
    """拼板按原始画面比例缩放，避免把竖屏或 4:3 视频强制拉成 16:9。"""
    if not source_width or not source_height:
        return MAXIMUM_STORYBOARD_TILE_WIDTH, MAXIMUM_STORYBOARD_TILE_HEIGHT
    scale = min(
        MAXIMUM_STORYBOARD_TILE_WIDTH / source_width,
        MAXIMUM_STORYBOARD_TILE_HEIGHT / source_height,
    )
    return (
        max(1, round(source_width * scale)),
        max(1, round(source_height * scale)),
    )


def storyboard_rows(storyboard: ThumbnailStoryboard) -> int:
    return math.ceil(storyboard.total_tiles / storyboard.columns)


def build_thumbnail_tiles(storyboard: ThumbnailStoryboard) -> list[ThumbnailTile]:
    return [
        ThumbnailTile(
            start_time=index * storyboard.interval_seconds,
            x=(index % storyboard.columns) * storyboard.tile_width,
            y=(index // storyboard.columns) * storyboard.tile_height,
        )
        for index in range(storyboard.total_tiles)
    ]
