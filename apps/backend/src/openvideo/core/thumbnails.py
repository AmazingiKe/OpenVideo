import math
from typing import Self

from pydantic import BaseModel, Field, model_validator


MAXIMUM_STORYBOARD_TILE_WIDTH = 640
MAXIMUM_STORYBOARD_TILE_HEIGHT = 360
STORYBOARD_COLUMNS = 5
STORYBOARD_ROWS = 5
STORYBOARD_TILES_PER_PAGE = STORYBOARD_COLUMNS * STORYBOARD_ROWS
SHORT_STORYBOARD_INTERVAL_SECONDS = 5
LONG_STORYBOARD_INTERVAL_SECONDS = 10
LONG_STORYBOARD_DURATION_SECONDS = 2 * 60 * 60
MAXIMUM_STORYBOARD_TILES = 1_200
MAXIMUM_STORYBOARD_PAGES = math.ceil(
    MAXIMUM_STORYBOARD_TILES / STORYBOARD_TILES_PER_PAGE
)


class ThumbnailStoryboardPage(BaseModel):
    page_id: str
    relative_path: str = Field(min_length=1)
    start_index: int = Field(ge=0)
    tile_count: int = Field(gt=0, le=STORYBOARD_TILES_PER_PAGE)


class ThumbnailStoryboardManifest(BaseModel):
    storyboard_id: str
    tile_width: int = Field(gt=0, le=MAXIMUM_STORYBOARD_TILE_WIDTH)
    tile_height: int = Field(gt=0, le=MAXIMUM_STORYBOARD_TILE_HEIGHT)
    interval_seconds: float = Field(gt=0)
    columns: int = Field(gt=0, le=STORYBOARD_COLUMNS)
    total_tiles: int = Field(gt=0, le=MAXIMUM_STORYBOARD_TILES)
    pages: list[ThumbnailStoryboardPage] = Field(
        min_length=1,
        max_length=MAXIMUM_STORYBOARD_PAGES,
    )

    @model_validator(mode="after")
    def validate_page_ranges(self) -> Self:
        """连续页范围让前端可由时间直接定位，避免损坏清单显示错误画面。"""
        next_start_index = 0
        for page in self.pages:
            if page.start_index != next_start_index:
                raise ValueError("故事板页面范围必须连续")
            next_start_index += page.tile_count
        if next_start_index != self.total_tiles:
            raise ValueError("故事板页面帧数必须与总帧数一致")
        return self


class ThumbnailStoryboardPlan(BaseModel):
    tile_width: int
    tile_height: int
    interval_seconds: float
    columns: int
    total_tiles: int
    page_count: int


def build_thumbnail_storyboard_plan(
    duration_seconds: float | None,
    source_width: int | None = None,
    source_height: int | None = None,
) -> ThumbnailStoryboardPlan | None:
    """为长视频规划可分页加载的预览图，避免单张大图耗尽纹理内存。"""
    if not duration_seconds or duration_seconds <= 0:
        return None
    preferred_interval = (
        LONG_STORYBOARD_INTERVAL_SECONDS
        if duration_seconds > LONG_STORYBOARD_DURATION_SECONDS
        else SHORT_STORYBOARD_INTERVAL_SECONDS
    )
    uncapped_total_tiles = math.ceil(duration_seconds / preferred_interval)
    total_tiles = min(uncapped_total_tiles, MAXIMUM_STORYBOARD_TILES)
    interval_seconds = (
        preferred_interval
        if total_tiles == uncapped_total_tiles
        else duration_seconds / total_tiles
    )
    tile_width, tile_height = storyboard_tile_dimensions(
        source_width,
        source_height,
    )
    return ThumbnailStoryboardPlan(
        tile_width=tile_width,
        tile_height=tile_height,
        interval_seconds=interval_seconds,
        columns=STORYBOARD_COLUMNS,
        total_tiles=total_tiles,
        page_count=math.ceil(total_tiles / STORYBOARD_TILES_PER_PAGE),
    )


def storyboard_tile_dimensions(
    source_width: int | None,
    source_height: int | None,
) -> tuple[int, int]:
    """拼板按原始画面比例缩放，避免竖屏或 4:3 视频被强制拉成 16:9。"""
    if not source_width or not source_height:
        return MAXIMUM_STORYBOARD_TILE_WIDTH, MAXIMUM_STORYBOARD_TILE_HEIGHT
    scale = min(
        1.0,
        MAXIMUM_STORYBOARD_TILE_WIDTH / source_width,
        MAXIMUM_STORYBOARD_TILE_HEIGHT / source_height,
    )
    return (
        max(1, round(source_width * scale)),
        max(1, round(source_height * scale)),
    )


def storyboard_page_tile_count(
    plan: ThumbnailStoryboardPlan,
    page_index: int,
) -> int:
    first_tile_index = page_index * STORYBOARD_TILES_PER_PAGE
    return min(
        STORYBOARD_TILES_PER_PAGE,
        max(0, plan.total_tiles - first_tile_index),
    )
