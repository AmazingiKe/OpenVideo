import math

from openvideo.core.thumbnails import (
    LONG_STORYBOARD_INTERVAL_SECONDS,
    MAXIMUM_STORYBOARD_TILES,
    MAXIMUM_STORYBOARD_TILE_HEIGHT,
    SHORT_STORYBOARD_INTERVAL_SECONDS,
    STORYBOARD_COLUMNS,
    STORYBOARD_TILES_PER_PAGE,
    build_thumbnail_storyboard_plan,
    storyboard_page_tile_count,
)


def test_builds_paginated_storyboard_for_one_hour_video():
    storyboard = build_thumbnail_storyboard_plan(3_600)
    assert storyboard is not None
    assert storyboard.interval_seconds == SHORT_STORYBOARD_INTERVAL_SECONDS
    assert storyboard.total_tiles == 720
    assert storyboard.columns == STORYBOARD_COLUMNS
    assert storyboard.page_count == math.ceil(720 / STORYBOARD_TILES_PER_PAGE)


def test_builds_paginated_storyboard_for_three_hour_video():
    storyboard = build_thumbnail_storyboard_plan(3 * 60 * 60)
    assert storyboard is not None
    assert storyboard.interval_seconds == LONG_STORYBOARD_INTERVAL_SECONDS
    assert storyboard.total_tiles == 1_080
    assert storyboard.page_count == math.ceil(1_080 / STORYBOARD_TILES_PER_PAGE)


def test_skips_storyboard_for_empty_duration():
    assert build_thumbnail_storyboard_plan(0) is None
    assert build_thumbnail_storyboard_plan(None) is None


def test_counts_tiles_on_incomplete_last_page():
    storyboard = build_thumbnail_storyboard_plan(126)
    assert storyboard is not None
    assert storyboard.total_tiles == 26
    assert storyboard.page_count == 2
    assert storyboard_page_tile_count(storyboard, 0) == STORYBOARD_TILES_PER_PAGE
    assert storyboard_page_tile_count(storyboard, 1) == 1


def test_preserves_source_aspect_ratio_within_preview_bounds():
    storyboard = build_thumbnail_storyboard_plan(25, 1440, 1080)
    assert storyboard is not None
    assert (storyboard.tile_width, storyboard.tile_height) == (
        480,
        MAXIMUM_STORYBOARD_TILE_HEIGHT,
    )


def test_does_not_upscale_small_source_frames():
    storyboard = build_thumbnail_storyboard_plan(25, 320, 180)
    assert storyboard is not None
    assert (storyboard.tile_width, storyboard.tile_height) == (320, 180)


def test_caps_storyboards_beyond_the_supported_long_video_window():
    duration_seconds = 8 * 60 * 60
    storyboard = build_thumbnail_storyboard_plan(duration_seconds)
    assert storyboard is not None
    assert storyboard.total_tiles == MAXIMUM_STORYBOARD_TILES
    assert storyboard.interval_seconds == duration_seconds / MAXIMUM_STORYBOARD_TILES
