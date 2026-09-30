import { useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  format_timeline_time,
  TIMELINE_SECONDS_PER_HOUR,
} from "./timeline_time";

const RULER_MAJOR_MINIMUM_WIDTH_PIXELS = 60;
const RULER_MAJOR_MAXIMUM_WIDTH_PIXELS = 180;
const RULER_MAJOR_TARGET_WIDTH_PIXELS = 96;
const RULER_MINOR_TICK_COUNT = 5;
const RULER_FLOATING_POINT_TOLERANCE = 1e-9;
const RULER_INTERVALS_SECONDS = [
  0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1_200, 1_800,
  3_600, 7_200, 14_400, 28_800, 43_200, 86_400,
] as const;

export type TimelineRulerTick = {
  seconds: number;
  x: number;
  is_major: boolean;
  label: string | null;
};

type TimelineRulerPaintStyle = {
  height: number;
  major_tick_height: number;
  minor_tick_height: number;
  label_top: number;
  ruler_font: string;
  text_color: string;
  tick_color: string;
  minor_tick_color: string;
  label_gap: number;
};

type TimelineRulerCanvasProps = {
  canvas_width: number;
  duration_seconds: number;
  major_interval_seconds: number;
  scroll_left: number;
  start_left: number;
  zoom_pixels_per_second: number;
};

export function TimelineRulerCanvas({
  canvas_width,
  duration_seconds,
  major_interval_seconds,
  scroll_left,
  start_left,
  zoom_pixels_per_second,
}: TimelineRulerCanvasProps) {
  const canvas_ref = useRef<HTMLCanvasElement>(null);
  const paint_style_ref = useRef<TimelineRulerPaintStyle | null>(null);
  const [size_revision, set_size_revision] = useState(0);

  useLayoutEffect(() => {
    const canvas = canvas_ref.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => {
      // CSS 高度变化后必须同步位图尺寸，不能继续拉伸缓存的旧画布。
      paint_style_ref.current = null;
      set_size_revision((revision) => revision + 1);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const canvas = canvas_ref.current;
    if (!canvas || canvas_width <= 0) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let paint_style = paint_style_ref.current;
    if (!paint_style) {
      const computed_style = getComputedStyle(
        canvas.ownerDocument.documentElement,
      );
      paint_style = {
        height: parseFloat(
          computed_style.getPropertyValue("--timeline-ruler-height"),
        ),
        major_tick_height: parseFloat(
          computed_style.getPropertyValue("--timeline-ruler-major-tick-height"),
        ),
        minor_tick_height: parseFloat(
          computed_style.getPropertyValue("--timeline-ruler-minor-tick-height"),
        ),
        label_top: parseFloat(
          computed_style.getPropertyValue("--timeline-ruler-label-top"),
        ),
        minor_tick_color: computed_style
          .getPropertyValue("--timeline-color-ruler-minor-tick")
          .trim(),
        label_gap: parseFloat(
          computed_style.getPropertyValue("--timeline-label-gap"),
        ),
        tick_color: computed_style
          .getPropertyValue("--timeline-color-ruler-tick")
          .trim(),
        text_color: computed_style
          .getPropertyValue("--timeline-color-ruler-text")
          .trim(),
        ruler_font: computed_style
          .getPropertyValue("--timeline-ruler-font")
          .trim(),
      };
      paint_style_ref.current = paint_style;
    }

    const device_pixel_ratio = Math.max(window.devicePixelRatio || 1, 1);
    const bitmap_size = timeline_ruler_bitmap_size(
      canvas_width,
      paint_style.height,
      device_pixel_ratio,
    );
    if (canvas.width !== bitmap_size.width) canvas.width = bitmap_size.width;
    if (canvas.height !== bitmap_size.height)
      canvas.height = bitmap_size.height;

    const ticks = create_visible_timeline_ruler_ticks({
      canvas_width,
      duration_seconds,
      major_interval_seconds,
      scroll_left,
      start_left,
      zoom_pixels_per_second,
    });

    context.setTransform(device_pixel_ratio, 0, 0, device_pixel_ratio, 0, 0);
    context.clearRect(0, 0, canvas_width, paint_style.height);
    context.lineWidth = 1;
    context.strokeStyle = paint_style.tick_color;
    context.fillStyle = paint_style.text_color;
    context.font = paint_style.ruler_font;
    context.textAlign = "center";
    context.textBaseline = "top";

    let label_right = -Infinity;
    for (const tick of ticks) {
      const aligned_x =
        Math.round(tick.x * device_pixel_ratio) / device_pixel_ratio +
        0.5 / device_pixel_ratio;
      const tick_height = tick.is_major
        ? paint_style.major_tick_height
        : paint_style.minor_tick_height;
      context.strokeStyle = tick.is_major
        ? paint_style.tick_color
        : paint_style.minor_tick_color;
      context.beginPath();
      context.moveTo(aligned_x, paint_style.height - tick_height);
      context.lineTo(aligned_x, paint_style.height);
      context.stroke();
      if (tick.label !== null) {
        const width = context.measureText(tick.label).width;
        const label_x = Math.max(
          width / 2,
          Math.min(tick.x, canvas_width - width / 2),
        );
        const left = label_x - width / 2;
        if (
          width <= canvas_width &&
          left >= label_right + paint_style.label_gap
        ) {
          context.fillText(tick.label, label_x, paint_style.label_top);
          label_right = label_x + width / 2;
        }
      }
    }
  }, [
    canvas_width,
    size_revision,
    duration_seconds,
    major_interval_seconds,
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

type TimelineGridProps = TimelineRulerCanvasProps;

export function TimelineGrid({
  canvas_width,
  duration_seconds,
  major_interval_seconds,
  scroll_left,
  start_left,
  zoom_pixels_per_second,
}: TimelineGridProps) {
  const lines = useMemo(
    () =>
      create_visible_timeline_ruler_ticks({
        canvas_width,
        duration_seconds,
        major_interval_seconds,
        scroll_left,
        start_left,
        zoom_pixels_per_second,
      }).filter((tick) => tick.is_major),
    [
      canvas_width,
      duration_seconds,
      major_interval_seconds,
      scroll_left,
      start_left,
      zoom_pixels_per_second,
    ],
  );

  return (
    <div className="timeline_grid" aria-hidden="true">
      {lines.map((line) => (
        <span
          key={line.seconds}
          className="timeline_grid_line"
          style={{ left: line.x }}
        />
      ))}
    </div>
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
      label: is_major
        ? format_timeline_ruler_time(
            seconds,
            major_interval_seconds,
            duration_seconds,
          )
        : null,
    });
  }
  return ticks;
}

export function format_timeline_ruler_time(
  seconds: number,
  interval_seconds: number,
  duration_seconds: number,
): string {
  return format_timeline_time(seconds, {
    milliseconds: interval_seconds < 1,
    hours: duration_seconds >= TIMELINE_SECONDS_PER_HOUR,
  });
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
