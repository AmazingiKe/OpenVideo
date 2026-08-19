import math

from openvideo.core.thumbnails import (
    SPRITE_TILE_HEIGHT,
    SPRITE_TILE_WIDTH,
    build_thumbnail_storyboard,
    build_thumbnail_tiles,
    storyboard_rows,
)


def test_builds_storyboard_plan_for_positive_duration():
    storyboard = build_thumbnail_storyboard(3589)
    assert storyboard is not None
    assert storyboard.total_tiles == 718  # floor(3589 / 5) + 1
    assert storyboard.columns == 10
    assert storyboard_rows(storyboard) == math.ceil(718 / 10)


def test_skips_storyboard_for_empty_duration():
    assert build_thumbnail_storyboard(0) is None
    assert build_thumbnail_storyboard(None) is None


def test_builds_tiles_with_correct_positions():
    storyboard = build_thumbnail_storyboard(25)
    assert storyboard is not None
    tiles = build_thumbnail_tiles(storyboard)
    assert len(tiles) == 6  # t=0,5,10,15,20,25
    assert (tiles[0].start_time, tiles[0].x, tiles[0].y) == (0, 0, 0)
    assert (tiles[1].start_time, tiles[1].x, tiles[1].y) == (5, SPRITE_TILE_WIDTH, 0)
    assert (tiles[5].start_time, tiles[5].x, tiles[5].y) == (
        25,
        SPRITE_TILE_WIDTH * 5,
        0,
    )


def test_wraps_tiles_into_next_row():
    storyboard = build_thumbnail_storyboard(55)
    assert storyboard is not None
    tiles = build_thumbnail_tiles(storyboard)
    assert len(tiles) == 12  # t=0..55
    assert (tiles[10].start_time, tiles[10].x, tiles[10].y) == (50, 0, SPRITE_TILE_HEIGHT)
    assert (tiles[11].start_time, tiles[11].x, tiles[11].y) == (
        55,
        SPRITE_TILE_WIDTH,
        SPRITE_TILE_HEIGHT,
    )
