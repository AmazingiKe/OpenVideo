import type { TimelineEditor } from "@xzdarcy/react-timeline-editor";

import { format_marker_label } from "@/shared/marker_labels";
import type {
  AnalysisStrategy,
  EventAnalysis,
  FocusSelection,
  MediaMarker,
  MediaSegment,
  Transcript,
} from "@/shared/types";

const MINIMUM_DURATION_SECONDS = 1;
export const DEFAULT_ZOOM_PIXELS_PER_SECOND = 80;
export const MINIMUM_ACTION_DURATION_SECONDS = 0.05;
export const MARKER_TIME_STEP_SECONDS = 0.05;
const DEFAULT_POINT_HIT_DURATION_SECONDS = 0.4;
export const MINIMUM_ZOOM_PIXELS_PER_SECOND = 4;
export const MAXIMUM_ZOOM_PIXELS_PER_SECOND = 320;
const WHEEL_DELTA_MODE_PIXEL = 0;
const WHEEL_DELTA_MODE_LINE = 1;
const WHEEL_DELTA_MODE_PAGE = 2;
const WHEEL_LINE_HEIGHT_PIXELS = 16;
const MINIMUM_WHEEL_FRAME_FACTOR = 0.8;
const MAXIMUM_WHEEL_FRAME_FACTOR = 1.25;
const WHEEL_ZOOM_EPSILON = 1e-9;
export const TIMELINE_START_LEFT = 16;
export const TIMELINE_ROW_HEIGHT = 48;
const RENDER_WINDOW_BUFFER_VIEWPORTS = 0.5;
const RENDER_WINDOW_COVERAGE_MARGIN_VIEWPORTS = 0.1;
const RENDER_WINDOW_MOVEMENT_THRESHOLD_VIEWPORTS = 0.25;

export const TIMELINE_TRACK_IDS = {
  marker: "timeline-marker-track",
  transcript: "timeline-transcript-track",
  event: "timeline-event-track",
  focus: "timeline-focus-track",
  event_analysis_prefix: "timeline-event-analysis-track",
} as const;

export const MARKER_SHAPE_VALUES = {
  point: "point",
  range: "range",
} as const;

export type TimelineRow = TimelineEditor["editorData"][number];
export type TimelineAction = TimelineRow["actions"][number];
type TimelineActionKind =
  "marker" | "candidate" | "transcript" | "event" | "focus" | "event_analysis";
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
  const zoom_pixels_per_second = Math.min(
    MAXIMUM_ZOOM_PIXELS_PER_SECOND,
    Math.max(MINIMUM_ZOOM_PIXELS_PER_SECOND, requested_zoom),
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

export function consume_timeline_wheel_zoom_frame({
  viewport,
  events,
  scale_count,
}: {
  viewport: TimelineZoomViewport;
  events: TimelineWheelZoomEvent[];
  scale_count: number;
}): {
  viewport: TimelineZoomViewport;
  remaining_events: TimelineWheelZoomEvent[];
} {
  const frame_minimum_zoom = Math.max(
    MINIMUM_ZOOM_PIXELS_PER_SECOND,
    viewport.zoom_pixels_per_second * MINIMUM_WHEEL_FRAME_FACTOR,
  );
  const frame_maximum_zoom = Math.min(
    MAXIMUM_ZOOM_PIXELS_PER_SECOND,
    viewport.zoom_pixels_per_second * MAXIMUM_WHEEL_FRAME_FACTOR,
  );
  let next_viewport = viewport;

  for (let event_index = 0; event_index < events.length; event_index += 1) {
    const wheel_event = events[event_index];
    if (!wheel_event) continue;
    let remaining_delta = wheel_event.logarithmic_delta;
    if (Math.abs(remaining_delta) <= WHEEL_ZOOM_EPSILON) continue;

    const requested_zoom =
      next_viewport.zoom_pixels_per_second * Math.exp(remaining_delta);
    const frame_limited_zoom = Math.min(
      frame_maximum_zoom,
      Math.max(frame_minimum_zoom, requested_zoom),
    );
    const calculated_viewport = calculate_zoom_viewport({
      viewport: next_viewport,
      requested_zoom: frame_limited_zoom,
      anchor_x: wheel_event.anchor_x,
      viewport_width: wheel_event.viewport_width,
      scale_count,
    });
    const applied_delta = Math.log(
      calculated_viewport.zoom_pixels_per_second /
        next_viewport.zoom_pixels_per_second,
    );
    next_viewport = calculated_viewport;
    remaining_delta -= applied_delta;

    if (Math.abs(remaining_delta) <= WHEEL_ZOOM_EPSILON) continue;
    const reached_global_limit =
      (remaining_delta > 0 &&
        next_viewport.zoom_pixels_per_second >=
          MAXIMUM_ZOOM_PIXELS_PER_SECOND) ||
      (remaining_delta < 0 &&
        next_viewport.zoom_pixels_per_second <= MINIMUM_ZOOM_PIXELS_PER_SECOND);
    if (reached_global_limit) continue;

    return {
      viewport: next_viewport,
      remaining_events: [
        { ...wheel_event, logarithmic_delta: remaining_delta },
        ...events.slice(event_index + 1),
      ],
    };
  }

  return { viewport: next_viewport, remaining_events: [] };
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
  if (!invalid_bounds && !near_left_edge && !near_right_edge) {
    return render_window;
  }
  return create_timeline_render_window({ viewport, canvas_width, duration });
}

export function extend_timeline_render_window({
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
  const coverage_margin =
    visible_duration * RENDER_WINDOW_COVERAGE_MARGIN_VIEWPORTS;
  const required_start = Math.max(
    0,
    visible_range.start_seconds - coverage_margin,
  );
  const required_end = Math.min(
    duration,
    visible_range.end_seconds + coverage_margin,
  );
  const bounded_render_window = {
    start_seconds: Math.min(duration, Math.max(0, render_window.start_seconds)),
    end_seconds: Math.min(duration, Math.max(0, render_window.end_seconds)),
  };
  const covers_visible_range =
    bounded_render_window.start_seconds <= required_start &&
    bounded_render_window.end_seconds >= required_end;
  if (
    covers_visible_range &&
    timeline_render_windows_equal(render_window, bounded_render_window)
  ) {
    return render_window;
  }
  if (covers_visible_range) return bounded_render_window;

  const expanded_window = create_timeline_render_window({
    viewport,
    canvas_width,
    duration,
  });
  return {
    start_seconds: Math.min(
      bounded_render_window.start_seconds,
      expanded_window.start_seconds,
    ),
    end_seconds: Math.max(
      bounded_render_window.end_seconds,
      expanded_window.end_seconds,
    ),
  };
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

export function timeline_render_windows_equal(
  first: TimelineRenderWindow,
  second: TimelineRenderWindow,
): boolean {
  return (
    first.start_seconds === second.start_seconds &&
    first.end_seconds === second.end_seconds
  );
}

export function filter_timeline_rows_for_window(
  rows: TimelineRow[],
  render_window: TimelineRenderWindow,
): TimelineRow[] {
  return rows.map((row) => {
    if (row.id === TIMELINE_TRACK_IDS.marker) return row;
    return {
      ...row,
      actions: row.actions.filter(
        (action) =>
          action.end >= render_window.start_seconds &&
          action.start <= render_window.end_seconds,
      ),
    };
  });
}

export function build_timeline_rows({
  transcript_segments,
  segments,
  markers,
  candidate_markers,
  analysis_strategy,
  duration,
  selected_marker_id,
  selected_marker_ids,
  focus_selection = null,
  event_analyses = [],
}: {
  transcript_segments: Transcript["segments"];
  segments: MediaSegment[];
  markers: MediaMarker[];
  candidate_markers: MediaMarker[];
  analysis_strategy: AnalysisStrategy;
  duration: number;
  selected_marker_id: string | null;
  selected_marker_ids?: Set<string>;
  focus_selection?: FocusSelection | null;
  event_analyses?: EventAnalysis[];
}): TimelineRow[] {
  const event_analysis_rows = build_event_analysis_rows(
    event_analyses,
    duration,
  );
  return [
    {
      id: TIMELINE_TRACK_IDS.marker,
      rowHeight: TIMELINE_ROW_HEIGHT,
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
      rowHeight: TIMELINE_ROW_HEIGHT,
      classNames: ["timeline_row_transcript"],
      actions: transcript_segments.map((segment, index) =>
        create_timeline_action({
          id: `transcript-${index}`,
          start: segment.start_seconds,
          end: segment.end_seconds,
          duration,
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
    {
      id: TIMELINE_TRACK_IDS.event,
      rowHeight: TIMELINE_ROW_HEIGHT,
      classNames: ["timeline_row_events"],
      actions: segments.map((segment) =>
        create_timeline_action({
          id: `event-${segment.segment_id}`,
          start: segment.start_seconds,
          end: segment.end_seconds,
          duration,
          movable: false,
          flexible: false,
          data: {
            kind: "event",
            source_id: segment.segment_id,
            label: segment.title,
          },
        }),
      ),
    },
    ...(focus_selection
      ? [
          {
            id: TIMELINE_TRACK_IDS.focus,
            rowHeight: TIMELINE_ROW_HEIGHT,
            classNames: ["timeline_row_focus"],
            actions: create_focus_actions(focus_selection, duration),
          },
        ]
      : []),
    ...event_analysis_rows,
  ];
}

function create_focus_actions(
  selection: FocusSelection,
  duration: number,
): MediaTimelineAction[] {
  if (selection.in_seconds !== null && selection.out_seconds !== null) {
    return [
      create_timeline_action({
        id: selection.selection_id,
        start: selection.in_seconds,
        end: selection.out_seconds,
        duration,
        movable: false,
        flexible: false,
        data: {
          kind: "focus",
          source_id: selection.selection_id,
          label: "In / Out 焦点选区",
        },
      }),
    ];
  }
  return [
    ["in", selection.in_seconds],
    ["out", selection.out_seconds],
  ]
    .filter((endpoint): endpoint is [string, number] => endpoint[1] !== null)
    .map(([name, seconds]) =>
      create_timeline_action({
        id: `${selection.selection_id}-${name}`,
        start: seconds,
        end: seconds + MINIMUM_ACTION_DURATION_SECONDS,
        duration,
        movable: false,
        flexible: false,
        data: {
          kind: "focus",
          source_id: selection.selection_id,
          label: name === "in" ? "In 端点" : "Out 端点",
        },
      }),
    );
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
    actions: lane.map((group, group_index) =>
      create_timeline_action({
        id: `event-analysis-${lane_index}-${group_index}`,
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

export function round_marker_time(seconds: number): number {
  return Number(
    (
      Math.round(seconds / MARKER_TIME_STEP_SECONDS) * MARKER_TIME_STEP_SECONDS
    ).toFixed(2),
  );
}
