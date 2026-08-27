import { useLayoutEffect, useRef } from "react";

import { format_time } from "@/shared/format";

const RULER_HEIGHT_PIXELS = 32;
const RULER_MAJOR_TICK_HEIGHT_PIXELS = 8;
const RULER_MINOR_TICK_HEIGHT_PIXELS = 4;
const RULER_LABEL_TOP_PIXELS = 6;
const RULER_MAJOR_MINIMUM_WIDTH_PIXELS = 60;
const RULER_MAJOR_MAXIMUM_WIDTH_PIXELS = 180;
const RULER_MAJOR_TARGET_WIDTH_PIXELS = 96;
const RULER_MINOR_TICK_COUNT = 5;
const RULER_FLOATING_POINT_TOLERANCE = 1e-9;
const RULER_INTERVALS_SECONDS = [
  0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600,
] as const;

export type TimelineRulerTick = {
  seconds: number;
  x: number;
  is_major: boolean;
  label: string | null;
};

type TimelineRulerCanvasProps = {
  canvas_width: number;
  duration_seconds: number;
  scroll_left: number;
  start_left: number;
  zoom_pixels_per_second: number;
};

export function TimelineRulerCanvas({
  canvas_width,
  duration_seconds,
  scroll_left,
  start_left,
  zoom_pixels_per_second,
}: TimelineRulerCanvasProps) {
  const canvas_ref = useRef<HTMLCanvasElement>(null);
  const major_interval_ref = useRef<number | null>(null);

  useLayoutEffect(() => {
    const canvas = canvas_ref.current;
    if (!canvas || canvas_width <= 0) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const device_pixel_ratio = Math.max(window.devicePixelRatio || 1, 1);
    const bitmap_size = timeline_ruler_bitmap_size(
      canvas_width,
      RULER_HEIGHT_PIXELS,
      device_pixel_ratio,
    );
    if (canvas.width !== bitmap_size.width) canvas.width = bitmap_size.width;
    if (canvas.height !== bitmap_size.height)
      canvas.height = bitmap_size.height;

    const major_interval = select_timeline_ruler_interval(
      zoom_pixels_per_second,
      major_interval_ref.current,
    );
    major_interval_ref.current = major_interval;
    const ticks = create_visible_timeline_ruler_ticks({
      canvas_width,
      duration_seconds,
      major_interval_seconds: major_interval,
      scroll_left,
      start_left,
      zoom_pixels_per_second,
    });
    const computed_style = getComputedStyle(canvas);
    const tick_color = computed_style
      .getPropertyValue("--timeline-color-ruler-tick")
      .trim();
    const text_color = computed_style
      .getPropertyValue("--timeline-color-ruler-text")
      .trim();
    const ruler_font = computed_style
      .getPropertyValue("--timeline-ruler-font")
      .trim();

    context.setTransform(device_pixel_ratio, 0, 0, device_pixel_ratio, 0, 0);
    context.clearRect(0, 0, canvas_width, RULER_HEIGHT_PIXELS);
    context.lineWidth = 1;
    context.strokeStyle = tick_color;
    context.fillStyle = text_color;
    context.font = ruler_font;
    context.textAlign = "center";
    context.textBaseline = "top";

    for (const tick of ticks) {
      const aligned_x =
        Math.round(tick.x * device_pixel_ratio) / device_pixel_ratio +
        0.5 / device_pixel_ratio;
      const tick_height = tick.is_major
        ? RULER_MAJOR_TICK_HEIGHT_PIXELS
        : RULER_MINOR_TICK_HEIGHT_PIXELS;
      context.beginPath();
      context.moveTo(aligned_x, RULER_HEIGHT_PIXELS - tick_height);
      context.lineTo(aligned_x, RULER_HEIGHT_PIXELS);
      context.stroke();
      if (tick.label !== null) {
        context.fillText(tick.label, tick.x, RULER_LABEL_TOP_PIXELS);
      }
    }
  }, [
    canvas_width,
    duration_seconds,
    scroll_left,
    start_left,
    zoom_pixels_per_second,
  ]);

  return (
    <canvas
      ref={canvas_ref}
      className="timeline_ruler_canvas"
      aria-hidden="true"
    />
  );
}

export function select_timeline_ruler_interval(
  zoom_pixels_per_second: number,
  previous_interval_seconds: number | null,
): number {
  if (previous_interval_seconds !== null) {
    const previous_width = previous_interval_seconds * zoom_pixels_per_second;
    if (
      previous_width >= RULER_MAJOR_MINIMUM_WIDTH_PIXELS &&
      previous_width <= RULER_MAJOR_MAXIMUM_WIDTH_PIXELS
    ) {
      return previous_interval_seconds;
    }
  }

  const readable_intervals = RULER_INTERVALS_SECONDS.filter((interval) => {
    const width = interval * zoom_pixels_per_second;
    return (
      width >= RULER_MAJOR_MINIMUM_WIDTH_PIXELS &&
      width <= RULER_MAJOR_MAXIMUM_WIDTH_PIXELS
    );
  });
  const candidate_intervals =
    readable_intervals.length > 0
      ? readable_intervals
      : RULER_INTERVALS_SECONDS;
  return candidate_intervals.reduce((best, interval) => {
    const best_distance = Math.abs(
      best * zoom_pixels_per_second - RULER_MAJOR_TARGET_WIDTH_PIXELS,
    );
    const interval_distance = Math.abs(
      interval * zoom_pixels_per_second - RULER_MAJOR_TARGET_WIDTH_PIXELS,
    );
    return interval_distance < best_distance ? interval : best;
  });
}

export function create_visible_timeline_ruler_ticks({
  canvas_width,
  duration_seconds,
  major_interval_seconds,
  scroll_left,
  start_left,
  zoom_pixels_per_second,
}: {
  canvas_width: number;
  duration_seconds: number;
  major_interval_seconds: number;
  scroll_left: number;
  start_left: number;
  zoom_pixels_per_second: number;
}): TimelineRulerTick[] {
  const minor_interval_seconds =
    major_interval_seconds / RULER_MINOR_TICK_COUNT;
  const visible_start_seconds = Math.max(
    0,
    (scroll_left - start_left) / zoom_pixels_per_second,
  );
  const visible_end_seconds = Math.min(
    duration_seconds,
    Math.max(
      visible_start_seconds,
      (scroll_left + canvas_width - start_left) / zoom_pixels_per_second,
    ),
  );
  const first_tick_index = Math.max(
    0,
    Math.ceil(
      visible_start_seconds / minor_interval_seconds -
        RULER_FLOATING_POINT_TOLERANCE,
    ),
  );
  const last_tick_index = Math.floor(
    visible_end_seconds / minor_interval_seconds +
      RULER_FLOATING_POINT_TOLERANCE,
  );
  const ticks: TimelineRulerTick[] = [];

  for (
    let tick_index = first_tick_index;
    tick_index <= last_tick_index;
    tick_index += 1
  ) {
    const seconds = tick_index * minor_interval_seconds;
    const x = start_left + seconds * zoom_pixels_per_second - scroll_left;
    if (x < 0 || x > canvas_width) continue;
    const is_major = tick_index % RULER_MINOR_TICK_COUNT === 0;
    ticks.push({
      seconds,
      x,
      is_major,
      label: is_major ? format_timeline_ruler_time(seconds) : null,
    });
  }
  return ticks;
}

export function format_timeline_ruler_time(seconds: number): string {
  if (seconds < 1) return `${seconds.toFixed(2)}s`;
  return format_time(seconds);
}

export function timeline_ruler_bitmap_size(
  width: number,
  height: number,
  device_pixel_ratio: number,
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(width * device_pixel_ratio)),
    height: Math.max(1, Math.round(height * device_pixel_ratio)),
  };
}
