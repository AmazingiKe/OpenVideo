import type { ScrubPreviewStoryboard } from "./scrub_preview_protocol";

const MAX_PREVIEW_WIDTH_PIXELS = 1920;
const MAX_PREVIEW_HEIGHT_PIXELS = 1080;
const MAX_PREVIEW_PIXEL_COUNT = 2_073_600;
const MIN_PREVIEW_QUALITY_SCALE = 0.625;
const PREVIEW_QUALITY_SCALE_STEP = 0.8;
const SLOW_PREVIEW_DECODE_MILLISECONDS = 180;

export function preview_dimensions(
  player_width: number,
  player_height: number,
  pixel_ratio: number,
  quality_scale = 1,
) {
  const bounded_pixel_ratio = Math.min(Math.max(pixel_ratio, 1), 2);
  const bounded_quality_scale = Math.min(
    1,
    Math.max(MIN_PREVIEW_QUALITY_SCALE, quality_scale),
  );
  let width = Math.min(
    MAX_PREVIEW_WIDTH_PIXELS,
    Math.max(
      1,
      Math.round(player_width * bounded_pixel_ratio * bounded_quality_scale),
    ),
  );
  let height = Math.min(
    MAX_PREVIEW_HEIGHT_PIXELS,
    Math.max(
      1,
      Math.round(player_height * bounded_pixel_ratio * bounded_quality_scale),
    ),
  );
  const pixel_count = width * height;
  if (pixel_count > MAX_PREVIEW_PIXEL_COUNT) {
    const scale = Math.sqrt(MAX_PREVIEW_PIXEL_COUNT / pixel_count);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }
  return { width, height };
}

export function next_preview_quality_scale(
  current_scale: number,
  decode_milliseconds: number,
) {
  if (decode_milliseconds <= SLOW_PREVIEW_DECODE_MILLISECONDS) {
    return current_scale;
  }
  return Math.max(
    MIN_PREVIEW_QUALITY_SCALE,
    current_scale * PREVIEW_QUALITY_SCALE_STEP,
  );
}

export function storyboard_tile_at(
  storyboard: ScrubPreviewStoryboard,
  time_seconds: number,
) {
  let selected_tile = storyboard.tiles[0] ?? null;
  for (const tile of storyboard.tiles) {
    if (tile.start_time > time_seconds) break;
    selected_tile = tile;
  }
  return selected_tile;
}

export function contained_preview_rect(
  source_width: number,
  source_height: number,
  target_width: number,
  target_height: number,
) {
  const scale = Math.min(
    target_width / source_width,
    target_height / source_height,
  );
  const width = source_width * scale;
  const height = source_height * scale;
  return {
    x: (target_width - width) / 2,
    y: (target_height - height) / 2,
    width,
    height,
  };
}
