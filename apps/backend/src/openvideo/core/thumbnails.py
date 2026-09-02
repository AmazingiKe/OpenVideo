import math
from dataclasses import dataclass

SPRITE_TILE_WIDTH = 640
SPRITE_TILE_HEIGHT = 360
SPRITE_COLUMNS = 10
SPRITE_INTERVAL_SECONDS = 5
SPRITE_FILE_NAME = "thumbnails.jpg"


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


def build_thumbnail_storyboard(duration_seconds: float) -> ThumbnailStoryboard | None:
    """按固定间隔规划预览图拼板，供播放器在拖动时显示对应帧。"""
    if not duration_seconds or duration_seconds <= 0:
        return None
    total_tiles = int(duration_seconds // SPRITE_INTERVAL_SECONDS) + 1
    return ThumbnailStoryboard(
        sprite_path=SPRITE_FILE_NAME,
        tile_width=SPRITE_TILE_WIDTH,
        tile_height=SPRITE_TILE_HEIGHT,
        interval_seconds=SPRITE_INTERVAL_SECONDS,
        columns=SPRITE_COLUMNS,
        total_tiles=total_tiles,
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
