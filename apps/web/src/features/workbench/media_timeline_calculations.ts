import type { TimelineEditor } from "@xzdarcy/react-timeline-editor";

import { format_marker_label } from "@/shared/marker_labels";
import type {
  AnalysisStrategy,
  EventAnalysis,
  MediaMarker,
  MediaSegment,
  Transcript,
} from "@/shared/types";

const MINIMUM_DURATION_SECONDS = 1;
export const DEFAULT_ZOOM_PIXELS_PER_SECOND = 80;
export const MINIMUM_ACTION_DURATION_SECONDS = 0.05;
const MEDIA_TIME_PRECISION = 1_000_000;
const DEFAULT_POINT_HIT_DURATION_SECONDS = 0.4;
export const MAXIMUM_ZOOM_PIXELS_PER_SECOND = 320;
const WHEEL_DELTA_MODE_PIXEL = 0;
const WHEEL_DELTA_MODE_LINE = 1;
const WHEEL_DELTA_MODE_PAGE = 2;
const WHEEL_LINE_HEIGHT_PIXELS = 16;
export const TIMELINE_START_LEFT = 16;
export const TIMELINE_ROW_HEIGHT = 48;
export const TIMELINE_COMPACT_ROW_HEIGHT = 32;
export const TIMELINE_MINIMUM_ROW_HEIGHT = 24;
export const TIMELINE_MAXIMUM_ROW_HEIGHT = 160;
export const TIMELINE_RULER_HEIGHT = 32;
const TIMELINE_FIT_END_PADDING_PIXELS = 16;
const RENDER_WINDOW_BUFFER_VIEWPORTS = 0.5;
const RENDER_WINDOW_MAXIMUM_VIEWPORTS = 3;
const RENDER_WINDOW_MOVEMENT_THRESHOLD_VIEWPORTS = 0.25;

export const TIMELINE_TRACK_IDS = {
  marker: "timeline-marker-track",
  transcript: "timeline-transcript-track",
  event_analysis_prefix: "timeline-event-analysis-track",
} as const;

export const MARKER_SHAPE_VALUES = {
  point: "point",
  range: "range",
} as const;

export type TimelineRow = TimelineEditor["editorData"][number];
export type TimelineAction = TimelineRow["actions"][number];
type TimelineActionKind =
  "marker" | "candidate" | "transcript" | "event_analysis";
type MarkerShape =
  (typeof MARKER_SHAPE_VALUES)[keyof typeof MARKER_SHAPE_VALUES];

type TimelineActionData = {
  kind: TimelineActionKind;
  label: string;
  source_id?: string;
  source_index?: number;
  marker_shape?: MarkerShape;
  marker_anchor_seconds?: number;
  rendered_start_seconds?: number;
  event_analysis_ids?: string[];
};

export type MediaTimelineAction = TimelineAction & {
  data: TimelineActionData;
};

export type TimelineViewportState = {
  zoom_pixels_per_second: number;
  scroll_left: number;
  scroll_top: number;
};

export type TimelineZoomViewport = Pick<
  TimelineViewportState,
  "zoom_pixels_per_second" | "scroll_left"
>;

export type TimelineWheelZoomEvent = {
  logarithmic_delta: number;
  anchor_x: number;
  viewport_width: number;
};

export type TimelineRenderWindow = {
  start_seconds: number;
  end_seconds: number;
};

export type TimelineSelectionRange = {
  start_seconds: number;
  end_seconds: number;
};

export function calculate_minimum_timeline_zoom(
  viewport_width: number,
  scale_count: number,
): number {
  const available_width = Math.max(
    1,
    viewport_width - TIMELINE_START_LEFT - TIMELINE_FIT_END_PADDING_PIXELS,
  );
  const fit_zoom = available_width / Math.max(1, scale_count);
  return Math.min(DEFAULT_ZOOM_PIXELS_PER_SECOND, fit_zoom);
}

export function default_timeline_row_height(row_id: string): number {
  return row_id === TIMELINE_TRACK_IDS.marker ||
    row_id === TIMELINE_TRACK_IDS.transcript
    ? TIMELINE_COMPACT_ROW_HEIGHT
    : TIMELINE_ROW_HEIGHT;
}

export function clamp_timeline_row_height(height: number): number {
  return Math.min(
    TIMELINE_MAXIMUM_ROW_HEIGHT,
    Math.max(TIMELINE_MINIMUM_ROW_HEIGHT, height),
  );
}

export function selected_timeline_range(
  rows: TimelineRow[],
  aggregates: TimelineAggregate[] = [],
): TimelineSelectionRange | null {
  const selected_actions = rows.flatMap((row) =>
    (row.actions as MediaTimelineAction[]).filter((action) => action.selected),
  );
  if (selected_actions.length === 0) return null;
  const selected_ids = new Set(selected_actions.map((action) => action.id));
  const selected_groups = aggregates.filter((group) =>
    group.members.some((member) => selected_ids.has(member.id)),
  );
  const grouped_ids = new Set(
    selected_groups.flatMap((group) =>
      group.members.map((member) => member.id),
    ),
  );
  const ranges = [
    ...selected_groups,
    ...selected_actions
      .filter((action) => !grouped_ids.has(action.id))
      .map((action) => ({
        start_seconds: action.start,
        end_seconds: action.end,
      })),
  ];
  return {
    start_seconds: Math.min(...ranges.map((range) => range.start_seconds)),
    end_seconds: Math.max(...ranges.map((range) => range.end_seconds)),
  };
}

export type TimelineMarqueePoint = {
  x: number;
  y: number;
};

export type TimelineMarqueeRectangle = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

export function normalize_timeline_marquee_rectangle(
  anchor: TimelineMarqueePoint,
  current: TimelineMarqueePoint,
): TimelineMarqueeRectangle {
  const left = Math.min(anchor.x, current.x);
  const right = Math.max(anchor.x, current.x);
  const top = Math.min(anchor.y, current.y);
  const bottom = Math.max(anchor.y, current.y);
  return {
    left,
    right,
    top,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

export function timeline_marquee_exceeds_drag_threshold(
  rectangle: TimelineMarqueeRectangle,
  threshold: number,
): boolean {
  return rectangle.width >= threshold || rectangle.height >= threshold;
}

export function hit_test_timeline_marquee({
  rectangle,
  rows,
  viewport,
  aggregates = [],
  ruler_height = TIMELINE_RULER_HEIGHT,
}: {
  rectangle: TimelineMarqueeRectangle;
  rows: TimelineRow[];
  viewport: TimelineViewportState;
  aggregates?: TimelineAggregate[];
  ruler_height?: number;
}): MediaTimelineAction[] {
  const matches: MediaTimelineAction[] = [];
  let row_top = ruler_height - viewport.scroll_top;

  for (const row of rows) {
    const row_height = row.rowHeight ?? TIMELINE_ROW_HEIGHT;
    const row_bottom = row_top + row_height;
    const intersects_row =
      row_top <= rectangle.bottom && row_bottom >= rectangle.top;
    if (intersects_row) {
      for (const action of row.actions as MediaTimelineAction[]) {
        const action_left =
          TIMELINE_START_LEFT +
          action.start * viewport.zoom_pixels_per_second -
          viewport.scroll_left;
        const action_right =
          TIMELINE_START_LEFT +
          action.end * viewport.zoom_pixels_per_second -
          viewport.scroll_left;
        const intersects_time =
          action_left <= rectangle.right && action_right >= rectangle.left;
        if (intersects_time) matches.push(action);
      }
    }
    row_top = row_bottom;
  }

  for (const group of aggregates) {
    const left = group.left - viewport.scroll_left;
    const right = group.right - viewport.scroll_left;
    const top = ruler_height + group.top - viewport.scroll_top;
    const bottom = top + group.height;
    if (
      left <= rectangle.right &&
      right >= rectangle.left &&
      top <= rectangle.bottom &&
      bottom >= rectangle.top
    ) {
      matches.push(...group.members);
    }
  }

  return matches;
}

export function calculate_zoom_viewport({
  viewport,
  requested_zoom,
  anchor_x,
  viewport_width,
  scale_count,
}: {
  viewport: TimelineZoomViewport;
  requested_zoom: number;
  anchor_x: number;
  viewport_width: number;
  scale_count: number;
}): TimelineZoomViewport {
  const minimum_zoom_pixels_per_second = calculate_minimum_timeline_zoom(
    viewport_width,
    scale_count,
  );
  const zoom_pixels_per_second = Math.min(
    MAXIMUM_ZOOM_PIXELS_PER_SECOND,
    Math.max(minimum_zoom_pixels_per_second, requested_zoom),
  );
  const bounded_anchor_x = Math.min(
    Math.max(anchor_x, 0),
    Math.max(viewport_width, 0),
  );
  const anchor_time = Math.max(
    0,
    (viewport.scroll_left + bounded_anchor_x - TIMELINE_START_LEFT) /
      viewport.zoom_pixels_per_second,
  );
  const requested_scroll_left =
    anchor_time * zoom_pixels_per_second +
    TIMELINE_START_LEFT -
    bounded_anchor_x;
  const content_width =
    Math.max(0, scale_count) * zoom_pixels_per_second + TIMELINE_START_LEFT;
  const maximum_scroll_left = Math.max(
    0,
    content_width - Math.max(0, viewport_width),
  );
  return {
    zoom_pixels_per_second,
    scroll_left: Math.min(
      maximum_scroll_left,
      Math.max(0, requested_scroll_left),
    ),
  };
}

export function calculate_playhead_follow_scroll_left({
  time,
  viewport,
  viewport_width,
  scale_count,
}: {
  time: number;
  viewport: TimelineZoomViewport;
  viewport_width: number;
  scale_count: number;
}): number | null {
  const bounded_viewport_width = Math.max(0, viewport_width);
  const playhead_x =
    TIMELINE_START_LEFT +
    time * viewport.zoom_pixels_per_second -
    viewport.scroll_left;
  const playhead_is_visible =
    playhead_x >= TIMELINE_START_LEFT && playhead_x < bounded_viewport_width;
  if (playhead_is_visible) return null;

  const content_width =
    Math.max(0, scale_count) * viewport.zoom_pixels_per_second +
    TIMELINE_START_LEFT;
  const maximum_scroll_left = Math.max(
    0,
    content_width - bounded_viewport_width,
  );
  const requested_scroll_left = Math.max(
    0,
    time * viewport.zoom_pixels_per_second,
  );
  return Math.min(maximum_scroll_left, requested_scroll_left);
}

export function normalize_wheel_delta(
  delta: number,
  delta_mode: number,
  page_height: number,
): number {
  if (!Number.isFinite(delta)) return 0;
  if (delta_mode === WHEEL_DELTA_MODE_PIXEL) return delta;
  if (delta_mode === WHEEL_DELTA_MODE_LINE) {
    return delta * WHEEL_LINE_HEIGHT_PIXELS;
  }
  if (delta_mode === WHEEL_DELTA_MODE_PAGE) {
    return delta * Math.max(page_height, 1);
  }
  return delta;
}

/** 每帧消化全部输入，保留各次指针锚点，避免反向操作仍在追赶旧事件。 */
export function calculate_timeline_wheel_zoom({
  viewport,
  events,
  scale_count,
}: {
  viewport: TimelineZoomViewport;
  events: TimelineWheelZoomEvent[];
  scale_count: number;
}): TimelineZoomViewport {
  let next_viewport = viewport;
  for (const event of events) {
    if (
      !Number.isFinite(event.logarithmic_delta) ||
      event.logarithmic_delta === 0
    )
      continue;
    next_viewport = calculate_zoom_viewport({
      viewport: next_viewport,
      requested_zoom:
        next_viewport.zoom_pixels_per_second *
        Math.exp(event.logarithmic_delta),
      anchor_x: event.anchor_x,
      viewport_width: event.viewport_width,
      scale_count,
    });
  }
  return next_viewport;
}

export function create_timeline_render_window({
  viewport,
  canvas_width,
  duration,
}: {
  viewport: TimelineZoomViewport;
  canvas_width: number;
  duration: number;
}): TimelineRenderWindow {
  const visible_duration = canvas_width / viewport.zoom_pixels_per_second;
  const visible_range = calculate_timeline_visible_range({
    viewport,
    canvas_width,
    duration,
  });
  const buffer_duration = visible_duration * RENDER_WINDOW_BUFFER_VIEWPORTS;
  return {
    start_seconds: Math.max(0, visible_range.start_seconds - buffer_duration),
    end_seconds: Math.min(
      duration,
      visible_range.end_seconds + buffer_duration,
    ),
  };
}

export function update_timeline_render_window({
  render_window,
  viewport,
  canvas_width,
  duration,
}: {
  render_window: TimelineRenderWindow;
  viewport: TimelineZoomViewport;
  canvas_width: number;
  duration: number;
}): TimelineRenderWindow {
  const visible_duration = canvas_width / viewport.zoom_pixels_per_second;
  const visible_range = calculate_timeline_visible_range({
    viewport,
    canvas_width,
    duration,
  });
  const movement_threshold =
    visible_duration * RENDER_WINDOW_MOVEMENT_THRESHOLD_VIEWPORTS;
  const invalid_bounds =
    render_window.start_seconds < 0 ||
    render_window.start_seconds > visible_range.start_seconds ||
    render_window.end_seconds < visible_range.end_seconds ||
    render_window.end_seconds > duration;
  const near_left_edge =
    render_window.start_seconds > 0 &&
    visible_range.start_seconds - render_window.start_seconds <
      movement_threshold;
  const near_right_edge =
    render_window.end_seconds < duration &&
    render_window.end_seconds - visible_range.end_seconds < movement_threshold;
  const oversized_window =
    render_window.end_seconds - render_window.start_seconds >
    visible_duration * RENDER_WINDOW_MAXIMUM_VIEWPORTS;
  if (
    !invalid_bounds &&
    !near_left_edge &&
    !near_right_edge &&
    !oversized_window
  ) {
    return render_window;
  }
  return create_timeline_render_window({ viewport, canvas_width, duration });
}

function calculate_timeline_visible_range({
  viewport,
  canvas_width,
  duration,
}: {
  viewport: TimelineZoomViewport;
  canvas_width: number;
  duration: number;
}): TimelineRenderWindow {
  const start_seconds = Math.min(
    duration,
    Math.max(
      0,
      (viewport.scroll_left - TIMELINE_START_LEFT) /
        viewport.zoom_pixels_per_second,
    ),
  );
  return {
    start_seconds,
    end_seconds: Math.min(
      duration,
      Math.max(
        start_seconds,
        (viewport.scroll_left + canvas_width - TIMELINE_START_LEFT) /
          viewport.zoom_pixels_per_second,
      ),
    ),
  };
}

type TimelineRowWindowIndex = {
  actions: TimelineAction[];
  maximum_ends: number[];
};

const TIMELINE_ROW_WINDOW_INDEXES = new WeakMap<
  TimelineAction[],
  TimelineRowWindowIndex
>();

/** 只读轨道复用索引；标记由编辑器原地修改，必须按实时范围裁剪。 */
export function filter_timeline_rows_for_window(
  rows: TimelineRow[],
  render_window: TimelineRenderWindow,
): TimelineRow[] {
  return rows.map((row) => {
    if (row.id === TIMELINE_TRACK_IDS.marker) {
      return {
        ...row,
        actions: row.actions.filter(
          (action) =>
            action.end >= render_window.start_seconds &&
            action.start <= render_window.end_seconds,
        ),
      };
    }
    let index = TIMELINE_ROW_WINDOW_INDEXES.get(row.actions);
    if (!index) {
      const actions = [...row.actions].sort(
        (first, second) => first.start - second.start,
      );
      let maximum_end = -Infinity;
      const maximum_ends = actions.map((action) => {
        maximum_end = Math.max(maximum_end, action.end);
        return maximum_end;
      });
      index = { actions, maximum_ends };
      TIMELINE_ROW_WINDOW_INDEXES.set(row.actions, index);
    }
    let left = 0;
    let right = index.actions.length;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (index.maximum_ends[middle] < render_window.start_seconds)
        left = middle + 1;
      else right = middle;
    }
    const actions: TimelineAction[] = [];
    for (
      let action_index = left;
      action_index < index.actions.length;
      action_index += 1
    ) {
      const action = index.actions[action_index];
      if (action.start > render_window.end_seconds) break;
      if (action.end >= render_window.start_seconds) actions.push(action);
    }
    return {
      ...row,
      actions,
    };
  });
}

export function build_timeline_rows({
  transcript_segments = [],
  markers = [],
  candidate_markers = [],
  analysis_strategy,
  duration,
  selected_marker_id = null,
  selected_marker_ids,
  selected_transcript_indices,
  selected_read_only_action_ids,
  event_analyses = [],
  row_heights = {},
}: {
  transcript_segments?: Transcript["segments"];
  markers?: MediaMarker[];
  candidate_markers?: MediaMarker[];
  analysis_strategy: AnalysisStrategy;
  duration: number;
  selected_marker_id?: string | null;
  selected_marker_ids?: Set<string>;
  selected_transcript_indices?: ReadonlySet<number>;
  selected_read_only_action_ids?: ReadonlySet<string>;
  event_analyses?: EventAnalysis[];
  row_heights?: Readonly<Record<string, number>>;
}): TimelineRow[] {
  const event_analysis_rows = build_event_analysis_rows(
    event_analyses,
    duration,
  );
  const rows = [
    {
      id: TIMELINE_TRACK_IDS.marker,
      rowHeight: default_timeline_row_height(TIMELINE_TRACK_IDS.marker),
      classNames: ["timeline_row_markers"],
      actions: [
        ...markers.map((marker) =>
          create_marker_action(
            marker,
            analysis_strategy,
            duration,
            selected_marker_ids?.has(marker.marker_id) ??
              marker.marker_id === selected_marker_id,
          ),
        ),
        ...candidate_markers.map((marker) =>
          create_timeline_action({
            id: `candidate-${marker.marker_id}`,
            start: marker.start_seconds,
            end:
              marker.end_seconds ??
              marker.start_seconds + MINIMUM_ACTION_DURATION_SECONDS,
            duration,
            selected: selected_read_only_action_ids?.has(
              `candidate-${marker.marker_id}`,
            ),
            movable: false,
            flexible: false,
            data: {
              kind: "candidate",
              source_id: marker.marker_id,
              label: `待审批 · ${format_marker_label(marker)}`,
            },
          }),
        ),
      ],
    },
    {
      id: TIMELINE_TRACK_IDS.transcript,
      rowHeight: default_timeline_row_height(TIMELINE_TRACK_IDS.transcript),
      classNames: ["timeline_row_transcript"],
      actions: transcript_segments.map((segment, index) =>
        create_timeline_action({
          id: `transcript-${index}`,
          start: segment.start_seconds,
          end: segment.end_seconds,
          duration,
          selected: selected_transcript_indices?.has(index) ?? false,
          movable: false,
          flexible: false,
          data: {
            kind: "transcript",
            source_index: index,
            label: segment.text,
          },
        }),
      ),
    },
    ...event_analysis_rows.map((row) => ({
      ...row,
      actions: row.actions.map((action) => ({
        ...action,
        selected: selected_read_only_action_ids?.has(action.id) ?? false,
      })),
    })),
  ];
  return rows.map((row) => ({
    ...row,
    rowHeight: clamp_timeline_row_height(
      row_heights[row.id] ?? default_timeline_row_height(row.id),
    ),
  }));
}

function build_event_analysis_rows(
  analyses: EventAnalysis[],
  duration: number,
): TimelineRow[] {
  const grouped = new Map<
    string,
    { start: number; end: number; ids: string[]; titles: string[] }
  >();
  for (const analysis of analyses) {
    const target_id =
      analysis.target.source === "marker"
        ? analysis.target.marker_id
        : analysis.target.selection_id;
    const key = `${analysis.target.source}:${target_id}:${analysis.target.start_seconds}:${analysis.target.end_seconds}`;
    const group = grouped.get(key) ?? {
      start: analysis.target.start_seconds,
      end: analysis.target.end_seconds,
      ids: [],
      titles: [],
    };
    group.ids.push(analysis.event_analysis_id);
    group.titles.push(analysis.title);
    grouped.set(key, group);
  }
  const groups = [...grouped.values()].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const lanes: (typeof groups)[] = [];
  for (const group of groups) {
    const lane_index = lanes.findIndex((lane) => {
      const previous = lane.at(-1);
      return previous === undefined || previous.end <= group.start;
    });
    if (lane_index === -1) lanes.push([group]);
    else lanes[lane_index]?.push(group);
  }
  return lanes.map((lane, lane_index) => ({
    id: `${TIMELINE_TRACK_IDS.event_analysis_prefix}-${lane_index}`,
    rowHeight: TIMELINE_ROW_HEIGHT,
    classNames: ["timeline_row_event_analyses"],
    actions: lane.map((group) =>
      create_timeline_action({
        id: `event-analysis-${group.ids.join("+")}`,
        start: group.start,
        end: group.end,
        duration,
        movable: false,
        flexible: false,
        data: {
          kind: "event_analysis",
          source_id: group.ids[0],
          event_analysis_ids: group.ids,
          label:
            group.ids.length === 1
              ? (group.titles[0] ?? "事件分析")
              : `${group.ids.length} 条事件分析`,
        },
      }),
    ),
  }));
}

function create_marker_action(
  marker: MediaMarker,
  analysis_strategy: AnalysisStrategy,
  duration: number,
  is_selected: boolean,
): MediaTimelineAction {
  if (marker.end_seconds !== null) {
    return create_timeline_action({
      id: marker.marker_id,
      start: marker.start_seconds,
      end: marker.end_seconds,
      duration,
      selected: is_selected,
      movable: true,
      flexible: is_selected,
      data: {
        kind: "marker",
        source_id: marker.marker_id,
        label: format_marker_label(marker),
        marker_shape: MARKER_SHAPE_VALUES.range,
        marker_anchor_seconds: marker.start_seconds,
        rendered_start_seconds: marker.start_seconds,
      },
    });
  }

  const half_hit_duration = DEFAULT_POINT_HIT_DURATION_SECONDS / 2;
  const before_seconds = is_selected
    ? analysis_strategy.marker_range_before_seconds
    : half_hit_duration;
  const after_seconds = is_selected
    ? analysis_strategy.marker_range_after_seconds
    : half_hit_duration;
  const visible_range = bounded_action_range(
    marker.start_seconds - before_seconds,
    marker.start_seconds + after_seconds,
    duration,
  );
  return create_timeline_action({
    id: marker.marker_id,
    start: visible_range.start,
    end: visible_range.end,
    duration,
    selected: is_selected,
    movable: true,
    flexible: is_selected,
    data: {
      kind: "marker",
      source_id: marker.marker_id,
      label: format_marker_label(marker),
      marker_shape: MARKER_SHAPE_VALUES.point,
      marker_anchor_seconds: marker.start_seconds,
      rendered_start_seconds: visible_range.start,
    },
  });
}

function create_timeline_action({
  id,
  start,
  end,
  duration,
  selected = false,
  movable,
  flexible,
  data,
}: {
  id: string;
  start: number;
  end: number;
  duration: number;
  selected?: boolean;
  movable: boolean;
  flexible: boolean;
  data: TimelineActionData;
}): MediaTimelineAction {
  const range = bounded_action_range(start, end, duration);
  return {
    id,
    start: range.start,
    end: range.end,
    effectId: data.kind,
    selected,
    movable,
    flexible,
    minStart: 0,
    maxEnd: duration,
    disable: true,
    data: { ...data },
  };
}

function bounded_action_range(start: number, end: number, duration: number) {
  const bounded_start = Math.min(Math.max(start, 0), duration);
  const bounded_end = Math.min(Math.max(end, 0), duration);
  if (bounded_end - bounded_start >= MINIMUM_ACTION_DURATION_SECONDS) {
    return { start: bounded_start, end: bounded_end };
  }
  if (bounded_start + MINIMUM_ACTION_DURATION_SECONDS <= duration) {
    return {
      start: bounded_start,
      end: bounded_start + MINIMUM_ACTION_DURATION_SECONDS,
    };
  }
  return {
    start: Math.max(0, duration - MINIMUM_ACTION_DURATION_SECONDS),
    end: duration,
  };
}

export function timeline_content_duration(
  duration_seconds: number | null,
  transcript_segments: Transcript["segments"],
  segments: MediaSegment[],
  markers: MediaMarker[],
  candidate_markers: MediaMarker[],
): number {
  return Math.max(
    duration_seconds ?? 0,
    ...transcript_segments.map((segment) => segment.end_seconds),
    ...segments.map((segment) => segment.end_seconds),
    ...markers.map((marker) => marker.end_seconds ?? marker.start_seconds),
    ...candidate_markers.map(
      (marker) => marker.end_seconds ?? marker.start_seconds,
    ),
    MINIMUM_DURATION_SECONDS,
  );
}

export function normalize_marker_time(seconds: number): number {
  return Math.round(seconds * MEDIA_TIME_PRECISION) / MEDIA_TIME_PRECISION;
}

export const DEFAULT_TIMELINE_MERGE_THRESHOLD = 32;
const TIMELINE_MERGE_GAP_PIXELS = 4;
const TIMELINE_MINIMUM_BLOCK_WIDTH = 2;
const TIMELINE_RANGE_ZOOM_PADDING = 0.1;

export type TimelineAggregate = TimelineSelectionRange & {
  row_id: string;
  kind: MediaTimelineAction["data"]["kind"];
  members: MediaTimelineAction[];
  count: number;
  selected: boolean;
  left: number;
  right: number;
  top: number;
  height: number;
};

/** 按源数据排序，缩放和滚动复用顺序，避免在绘制期间重复排序。 */
export function sort_timeline_rows(rows: TimelineRow[]): TimelineRow[] {
  return rows.map((row) => ({
    ...row,
    actions: [...row.actions].sort(
      (first, second) => first.start - second.start,
    ),
  }));
}

/** 完整条宽决定分组，之后才裁剪，保证视口边缘不会改变成员关系。 */
export function aggregate_timeline_rows(
  rows: TimelineRow[],
  zoom: number,
  threshold: number,
) {
  const aggregates: TimelineAggregate[] = [];
  let source_count = 0;
  let source_area = 0;
  let row_top = 0;
  const independent_rows = rows.map((row) => {
    const height = row.rowHeight ?? TIMELINE_ROW_HEIGHT;
    const actions: MediaTimelineAction[] = [];
    const pending = new Map<
      MediaTimelineAction["data"]["kind"],
      TimelineAggregate
    >();
    function flush(kind: MediaTimelineAction["data"]["kind"]) {
      const group = pending.get(kind);
      if (!group) return;
      if (group.count > 1) aggregates.push(group);
      else actions.push(...group.members);
      pending.delete(kind);
    }
    for (const action of row.actions as MediaTimelineAction[]) {
      const kind = action.data.kind;
      const left = TIMELINE_START_LEFT + action.start * zoom;
      const width = Math.max(
        TIMELINE_MINIMUM_BLOCK_WIDTH,
        (action.end - action.start) * zoom,
      );
      const right = left + width;
      source_count += 1;
      source_area += width * height;
      if (threshold === 0 || width >= threshold) {
        flush(kind);
        actions.push(action);
        continue;
      }
      const previous = pending.get(kind);
      if (previous && left <= previous.right + TIMELINE_MERGE_GAP_PIXELS) {
        previous.members.push(action);
        previous.count += 1;
        previous.right = Math.max(previous.right, right);
        previous.end_seconds = Math.max(previous.end_seconds, action.end);
        previous.selected ||= Boolean(action.selected);
      } else {
        flush(kind);
        pending.set(kind, {
          row_id: row.id,
          kind,
          members: [action],
          count: 1,
          selected: Boolean(action.selected),
          left,
          right,
          top: row_top,
          height,
          start_seconds: action.start,
          end_seconds: action.end,
        });
      }
    }
    for (const kind of pending.keys()) flush(kind);
    row_top += height;
    return { ...row, actions };
  });
  const independent_count = independent_rows.reduce(
    (count, row) => count + row.actions.length,
    0,
  );
  return {
    independent_rows,
    aggregates,
    statistics: {
      source_count,
      source_area,
      independent_count,
      aggregate_count: aggregates.length,
      rendered_count: independent_count + aggregates.length,
    },
  };
}

export function calculate_timeline_range_viewport(
  range: TimelineSelectionRange,
  viewport_width: number,
  duration: number,
): TimelineZoomViewport {
  const range_duration = Math.max(
    MINIMUM_ACTION_DURATION_SECONDS,
    range.end_seconds - range.start_seconds,
  );
  const available_width = Math.max(1, viewport_width - TIMELINE_START_LEFT * 2);
  const requested_zoom =
    available_width / (range_duration * (1 + TIMELINE_RANGE_ZOOM_PADDING * 2));
  const zoom_pixels_per_second = Math.min(
    MAXIMUM_ZOOM_PIXELS_PER_SECOND,
    Math.max(
      calculate_minimum_timeline_zoom(viewport_width, duration),
      requested_zoom,
    ),
  );
  const center = (range.start_seconds + range.end_seconds) / 2;
  const maximum_scroll = Math.max(
    0,
    duration * zoom_pixels_per_second + TIMELINE_START_LEFT - viewport_width,
  );
  return {
    zoom_pixels_per_second,
    scroll_left: Math.min(
      maximum_scroll,
      Math.max(
        0,
        center * zoom_pixels_per_second +
          TIMELINE_START_LEFT -
          viewport_width / 2,
      ),
    ),
  };
}

/** 每个轨道只保留最近一次计算，编辑标记不必重新扫描转写或章节。 */
export function create_timeline_aggregator() {
  type AggregationResult = ReturnType<typeof aggregate_timeline_rows>;
  const cache = new WeakMap<
    TimelineRow,
    {
      zoom: number;
      threshold: number;
      height: number;
      result: AggregationResult;
    }
  >();
  return (
    rows: TimelineRow[],
    zoom: number,
    threshold: number,
    row_heights: Readonly<Record<string, number>>,
  ): AggregationResult => {
    const independent_rows: AggregationResult["independent_rows"] = [];
    const aggregates: TimelineAggregate[] = [];
    const statistics = {
      source_count: 0,
      source_area: 0,
      independent_count: 0,
      aggregate_count: 0,
      rendered_count: 0,
    };
    let top = 0;
    for (const row of rows) {
      const height =
        row_heights[row.id] ?? row.rowHeight ?? TIMELINE_ROW_HEIGHT;
      let entry = cache.get(row);
      if (
        !entry ||
        entry.zoom !== zoom ||
        entry.threshold !== threshold ||
        entry.height !== height
      ) {
        entry = {
          zoom,
          threshold,
          height,
          result: aggregate_timeline_rows(
            [{ ...row, rowHeight: height }],
            zoom,
            threshold,
          ),
        };
        cache.set(row, entry);
      }
      independent_rows.push(...entry.result.independent_rows);
      for (const group of entry.result.aggregates)
        aggregates.push({ ...group, top });
      const row_statistics = entry.result.statistics;
      statistics.source_count += row_statistics.source_count;
      statistics.source_area += row_statistics.source_area;
      statistics.independent_count += row_statistics.independent_count;
      statistics.aggregate_count += row_statistics.aggregate_count;
      statistics.rendered_count += row_statistics.rendered_count;
      top += height;
    }
    return { independent_rows, aggregates, statistics };
  };
}

/** 选择样式与源几何分离，点标记的编辑手柄不会改变聚合成员。 */
export function select_timeline_rows({
  rows,
  selected_marker_ids,
  selected_transcript_indices,
  selected_read_only_action_ids,
  analysis_strategy,
  duration,
  row_heights,
}: {
  rows: TimelineRow[];
  selected_marker_ids: ReadonlySet<string>;
  selected_transcript_indices: ReadonlySet<number>;
  selected_read_only_action_ids: ReadonlySet<string>;
  analysis_strategy: AnalysisStrategy;
  duration: number;
  row_heights: Readonly<Record<string, number>>;
}): TimelineRow[] {
  return rows.map((row) => ({
    ...row,
    rowHeight: row_heights[row.id] ?? row.rowHeight,
    actions: (row.actions as MediaTimelineAction[]).map((action) => {
      const data = { ...action.data };
      const selected =
        data.kind === "marker"
          ? selected_marker_ids.has(action.id)
          : data.kind === "transcript"
            ? selected_transcript_indices.has(data.source_index!)
            : selected_read_only_action_ids.has(action.id);
      const result = { ...action, data, selected };
      if (data.kind === "marker") result.flexible = selected;
      if (selected && data.marker_shape === MARKER_SHAPE_VALUES.point) {
        const anchor = data.marker_anchor_seconds!;
        const range = bounded_action_range(
          anchor - analysis_strategy.marker_range_before_seconds,
          anchor + analysis_strategy.marker_range_after_seconds,
          duration,
        );
        result.start = range.start;
        result.end = range.end;
        data.rendered_start_seconds = range.start;
      }
      return result;
    }),
  }));
}
