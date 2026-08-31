import { memo, useCallback, useLayoutEffect, useRef } from "react";

import type { ColorScheme } from "@/color_scheme";
import { use_color_scheme } from "@/use_color_scheme";
import {
  TIMELINE_ROW_HEIGHT,
  type MediaTimelineAction,
  type TimelineRow,
} from "./media_timeline_calculations";

const OVERVIEW_ENTER_ZOOM_PIXELS_PER_SECOND = 12;
const OVERVIEW_EXIT_ZOOM_PIXELS_PER_SECOND = 14;
const DETAIL_ENTER_ZOOM_PIXELS_PER_SECOND = 40;
const DETAIL_EXIT_ZOOM_PIXELS_PER_SECOND = 34;
const LOD_BLOCK_MINIMUM_WIDTH_PIXELS = 2;
const OVERVIEW_BLOCK_MERGE_GAP_PIXELS = 4;
const CHAPTER_BOUNDARY_GAP_PIXELS = 1;
const OVERVIEW_BLOCK_VERTICAL_INSET_PIXELS = 12;
const COMPACT_BLOCK_VERTICAL_INSET_PIXELS = 8;
const SELECTED_BLOCK_LINE_WIDTH_PIXELS = 2;

export const TIMELINE_LOD_VALUES = {
  overview: "overview",
  compact: "compact",
  detail: "detail",
} as const;

export type TimelineLod =
  (typeof TIMELINE_LOD_VALUES)[keyof typeof TIMELINE_LOD_VALUES];
type TimelineActionKind = MediaTimelineAction["data"]["kind"];

export type TimelineLodBlock = {
  count: number;
  kind: TimelineActionKind;
  left: number;
  right: number;
  selected: boolean;
};

type TimelineLodPaintStyle = {
  block_colors: Record<TimelineActionKind, string>;
  color_scheme: ColorScheme;
  selection_color: string;
};

type MediaTimelineLodCanvasProps = {
  canvas_width: number;
  lod: Exclude<TimelineLod, "detail">;
  rows: TimelineRow[];
  scroll_left: number;
  scroll_top: number;
  start_left: number;
  zoom_pixels_per_second: number;
};

export function select_timeline_lod(
  zoom_pixels_per_second: number,
  previous_lod: TimelineLod | null,
): TimelineLod {
  if (
    previous_lod === TIMELINE_LOD_VALUES.overview &&
    zoom_pixels_per_second < OVERVIEW_EXIT_ZOOM_PIXELS_PER_SECOND
  ) {
    return TIMELINE_LOD_VALUES.overview;
  }
  if (
    previous_lod === TIMELINE_LOD_VALUES.compact &&
    zoom_pixels_per_second > OVERVIEW_ENTER_ZOOM_PIXELS_PER_SECOND &&
    zoom_pixels_per_second < DETAIL_ENTER_ZOOM_PIXELS_PER_SECOND
  ) {
    return TIMELINE_LOD_VALUES.compact;
  }
  if (
    previous_lod === TIMELINE_LOD_VALUES.detail &&
    zoom_pixels_per_second > DETAIL_EXIT_ZOOM_PIXELS_PER_SECOND
  ) {
    return TIMELINE_LOD_VALUES.detail;
  }
  if (zoom_pixels_per_second <= OVERVIEW_ENTER_ZOOM_PIXELS_PER_SECOND) {
    return TIMELINE_LOD_VALUES.overview;
  }
  if (zoom_pixels_per_second < DETAIL_ENTER_ZOOM_PIXELS_PER_SECOND) {
    return TIMELINE_LOD_VALUES.compact;
  }
  return TIMELINE_LOD_VALUES.detail;
}

export function timeline_lod_label(lod: TimelineLod): string {
  if (lod === TIMELINE_LOD_VALUES.overview) return "概览";
  if (lod === TIMELINE_LOD_VALUES.compact) return "简化";
  return "详细";
}

export function create_timeline_lod_blocks({
  actions,
  canvas_width,
  lod,
  scroll_left,
  start_left,
  zoom_pixels_per_second,
}: {
  actions: MediaTimelineAction[];
  canvas_width: number;
  lod: Exclude<TimelineLod, "detail">;
  scroll_left: number;
  start_left: number;
  zoom_pixels_per_second: number;
}): TimelineLodBlock[] {
  const visible_blocks = actions.flatMap((action) => {
    const action_left =
      start_left + action.start * zoom_pixels_per_second - scroll_left;
    const action_right = Math.max(
      action_left + LOD_BLOCK_MINIMUM_WIDTH_PIXELS,
      start_left + action.end * zoom_pixels_per_second - scroll_left,
    );
    if (action_right < 0 || action_left > canvas_width) return [];
    return [
      {
        count: 1,
        kind: action.data.kind,
        left: Math.max(0, action_left),
        right: Math.min(canvas_width, action_right),
        selected: Boolean(action.selected),
      },
    ];
  });
  if (lod === TIMELINE_LOD_VALUES.compact) return visible_blocks;

  const blocks_by_kind = new Map<TimelineActionKind, TimelineLodBlock[]>();
  for (const block of visible_blocks) {
    const kind_blocks = blocks_by_kind.get(block.kind) ?? [];
    const previous = kind_blocks.at(-1);
    if (
      block.kind !== "event" &&
      previous &&
      block.left <= previous.right + OVERVIEW_BLOCK_MERGE_GAP_PIXELS
    ) {
      previous.right = Math.max(previous.right, block.right);
      previous.count += block.count;
      previous.selected ||= block.selected;
    } else {
      kind_blocks.push({ ...block });
      blocks_by_kind.set(block.kind, kind_blocks);
    }
  }
  return [...blocks_by_kind.values()]
    .flat()
    .sort((left, right) => left.left - right.left);
}

export const MediaTimelineLodCanvas = memo(function MediaTimelineLodCanvas({
  canvas_width,
  lod,
  rows,
  scroll_left,
  scroll_top,
  start_left,
  zoom_pixels_per_second,
}: MediaTimelineLodCanvasProps) {
  const canvas_ref = useRef<HTMLCanvasElement>(null);
  const paint_style_ref = useRef<TimelineLodPaintStyle | null>(null);
  const color_scheme = use_color_scheme();

  const draw = useCallback(() => {
    const canvas = canvas_ref.current;
    if (!canvas || canvas_width <= 0) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const measured_height = canvas.getBoundingClientRect().height;
    const content_height = rows.reduce(
      (height, row) => height + (row.rowHeight ?? TIMELINE_ROW_HEIGHT),
      0,
    );
    const canvas_height = Math.max(1, measured_height || content_height);
    const device_pixel_ratio = Math.max(window.devicePixelRatio || 1, 1);
    const bitmap_width = Math.max(
      1,
      Math.round(canvas_width * device_pixel_ratio),
    );
    const bitmap_height = Math.max(
      1,
      Math.round(canvas_height * device_pixel_ratio),
    );
    if (canvas.width !== bitmap_width) canvas.width = bitmap_width;
    if (canvas.height !== bitmap_height) canvas.height = bitmap_height;

    let paint_style = paint_style_ref.current;
    if (!paint_style || paint_style.color_scheme !== color_scheme) {
      const computed_style = getComputedStyle(canvas);
      paint_style = {
        color_scheme,
        block_colors: {
          marker: timeline_color(computed_style, "--timeline-color-marker"),
          candidate: timeline_color(
            computed_style,
            "--timeline-color-marker-border",
          ),
          transcript: timeline_color(
            computed_style,
            "--timeline-color-transcript-border",
          ),
          event: timeline_color(
            computed_style,
            "--timeline-color-event-border",
          ),
          focus: timeline_color(
            computed_style,
            "--timeline-color-selection-border",
          ),
          event_analysis: timeline_color(
            computed_style,
            "--timeline-color-event-analysis-border",
          ),
        },
        selection_color: timeline_color(
          computed_style,
          "--timeline-color-selection-border",
        ),
      };
      paint_style_ref.current = paint_style;
    }

    context.setTransform(device_pixel_ratio, 0, 0, device_pixel_ratio, 0, 0);
    context.clearRect(0, 0, canvas_width, canvas_height);
    let row_top = -scroll_top;
    for (const row of rows) {
      const row_height = row.rowHeight ?? TIMELINE_ROW_HEIGHT;
      const row_bottom = row_top + row_height;
      if (row_bottom >= 0 && row_top <= canvas_height) {
        const blocks = create_timeline_lod_blocks({
          actions: row.actions as MediaTimelineAction[],
          canvas_width,
          lod,
          scroll_left,
          start_left,
          zoom_pixels_per_second,
        });
        const vertical_inset =
          lod === TIMELINE_LOD_VALUES.overview
            ? OVERVIEW_BLOCK_VERTICAL_INSET_PIXELS
            : COMPACT_BLOCK_VERTICAL_INSET_PIXELS;
        const block_top = row_top + vertical_inset;
        const block_height = Math.max(1, row_height - vertical_inset * 2);
        for (const block of blocks) {
          context.globalAlpha =
            lod === TIMELINE_LOD_VALUES.overview
              ? Math.min(0.86, 0.46 + Math.log2(block.count + 1) * 0.1)
              : 0.82;
          context.fillStyle = paint_style.block_colors[block.kind];
          const boundary_gap =
            block.kind === "event" ? CHAPTER_BOUNDARY_GAP_PIXELS : 0;
          const block_width = Math.max(
            1,
            block.right - block.left - boundary_gap,
          );
          context.fillRect(block.left, block_top, block_width, block_height);
          if (block.selected) {
            context.globalAlpha = 1;
            context.lineWidth = SELECTED_BLOCK_LINE_WIDTH_PIXELS;
            context.strokeStyle = paint_style.selection_color;
            context.strokeRect(
              block.left,
              block_top,
              block_width,
              block_height,
            );
          }
        }
      }
      row_top = row_bottom;
    }
    context.globalAlpha = 1;
  }, [
    canvas_width,
    color_scheme,
    lod,
    rows,
    scroll_left,
    scroll_top,
    start_left,
    zoom_pixels_per_second,
  ]);

  useLayoutEffect(() => {
    const canvas = canvas_ref.current;
    if (!canvas) return;
    draw();
    const resize_observer = new ResizeObserver(draw);
    resize_observer.observe(canvas);
    return () => resize_observer.disconnect();
  }, [draw]);

  return (
    <canvas
      ref={canvas_ref}
      className="media_timeline_lod_canvas"
      data-lod={lod}
      aria-hidden="true"
    />
  );
});

function timeline_color(style: CSSStyleDeclaration, property: string): string {
  return style.getPropertyValue(property).trim();
}
