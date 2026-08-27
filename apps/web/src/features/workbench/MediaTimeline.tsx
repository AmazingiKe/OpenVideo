import {
  Timeline,
  type TimelineEditor,
  type TimelineState,
} from "@xzdarcy/react-timeline-editor";
import "@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css";
import {
  Captions,
  Flag,
  LockKeyhole,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  ScanSearch,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type WheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { format_time } from "@/shared/format";
import {
  format_marker_importance,
  format_marker_label,
} from "@/shared/marker_labels";
import type {
  AnalysisStrategy,
  MarkerImportance,
  MediaMarker,
  MediaMarkerUpdate,
  MediaSegment,
  Transcript,
} from "@/shared/types";

const MINIMUM_DURATION_SECONDS = 1;
const MINIMUM_ACTION_DURATION_SECONDS = 0.05;
const MARKER_TIME_STEP_SECONDS = 0.05;
const DEFAULT_POINT_HIT_DURATION_SECONDS = 0.4;
const DEFAULT_ZOOM_PIXELS_PER_SECOND = 80;
const MINIMUM_ZOOM_PIXELS_PER_SECOND = 4;
const MAXIMUM_ZOOM_PIXELS_PER_SECOND = 320;
const ZOOM_BUTTON_FACTOR = 1.25;
const ALT_WHEEL_ZOOM_SENSITIVITY = -0.001;
const TIMELINE_START_LEFT = 16;
const TIMELINE_ROW_HEIGHT = 48;
const TIMELINE_SCALE_SPLIT_COUNT = 5;
const DEFAULT_TIMELINE_CANVAS_WIDTH_PIXELS = 1024;
const RENDER_WINDOW_BUFFER_VIEWPORTS = 0.5;
const RENDER_WINDOW_MOVEMENT_THRESHOLD_VIEWPORTS = 0.25;
const MARKER_EDITOR_OFFSET = 8;
const MARKER_EDITOR_COLLISION_PADDING = 8;
const VIRTUALIZED_GRID_SELECTOR = ".ReactVirtualized__Grid";
const VIRTUALIZED_GRID_ROLE_SELECTOR = '[role="row"], [role="gridcell"]';
const EMPTY_MARKERS: MediaMarker[] = [];
const EMPTY_TIMELINE_EFFECTS: TimelineEditor["effects"] = {};
const MARKER_IMPORTANCE_VALUES: MarkerImportance[] = [0, 1, 2, 3, 4, 5];
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const MAJOR_SCALE_INTERVALS_SECONDS = [
  0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600,
] as const;

const TIMELINE_TRACK_IDS = {
  marker: "timeline-marker-track",
  transcript: "timeline-transcript-track",
  event: "timeline-event-track",
} as const;

const MARKER_SHAPE_VALUES = {
  point: "point",
  range: "range",
} as const;

function normalize_virtualized_timeline_accessibility(
  timeline_host: HTMLElement,
) {
  for (const grid of timeline_host.querySelectorAll(
    VIRTUALIZED_GRID_SELECTOR,
  )) {
    if (grid.getAttribute("role") !== "group") {
      grid.setAttribute("role", "group");
    }
    if (grid.getAttribute("aria-label") !== "时间线轨道内容") {
      grid.setAttribute("aria-label", "时间线轨道内容");
    }
    grid.removeAttribute("aria-readonly");
  }
  for (const element of timeline_host.querySelectorAll(
    VIRTUALIZED_GRID_ROLE_SELECTOR,
  )) {
    element.removeAttribute("role");
  }
}

type TimelineRow = TimelineEditor["editorData"][number];
type TimelineAction = TimelineRow["actions"][number];
type TimelineActionKind = "marker" | "candidate" | "transcript" | "event";
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
};

type MediaTimelineAction = TimelineAction & {
  data: TimelineActionData;
};

type TimelineViewportState = {
  zoom_pixels_per_second: number;
  scroll_left: number;
  scroll_top: number;
};

type TimelineZoomViewport = Pick<
  TimelineViewportState,
  "zoom_pixels_per_second" | "scroll_left"
>;

type TimelineRenderWindow = {
  start_seconds: number;
  end_seconds: number;
};

type TimelinePointerPosition = {
  x: number;
  y: number;
};

type TimelineTrackPresentation = {
  id: string;
  icon: LucideIcon;
  name: string;
  state: "可编辑" | "只读";
};

const TIMELINE_TRACK_PRESENTATIONS: TimelineTrackPresentation[] = [
  {
    id: TIMELINE_TRACK_IDS.marker,
    icon: Flag,
    name: "标记",
    state: "可编辑",
  },
  {
    id: TIMELINE_TRACK_IDS.transcript,
    icon: Captions,
    name: "转写",
    state: "只读",
  },
  {
    id: TIMELINE_TRACK_IDS.event,
    icon: ScanSearch,
    name: "分析事件",
    state: "只读",
  },
];

type MediaTimelineProps = {
  asset_id: string | null;
  duration_seconds: number | null;
  current_time: number;
  is_paused: boolean;
  playback_rate: number;
  transcript: Transcript | null;
  segments: MediaSegment[];
  markers: MediaMarker[];
  candidate_markers?: MediaMarker[];
  analysis_strategy: AnalysisStrategy;
  marker_error: string | null;
  on_scrub: (seconds: number) => void;
  on_seek: (seconds: number) => void;
  on_toggle_playback: () => void;
  on_playback_rate_change: (rate: number) => void;
  on_selected_transcript_indices_change: (segment_indices: number[]) => void;
  on_add_marker: (
    start_seconds: number,
    end_seconds?: number | null,
  ) => Promise<MediaMarker | undefined>;
  on_update_marker: (
    marker_id: string,
    update: MediaMarkerUpdate,
  ) => Promise<void>;
  on_delete_marker: (marker_id: string) => Promise<void>;
  on_update_transcript: (segment_index: number, text: string) => Promise<void>;
};

export function MediaTimeline({
  asset_id,
  duration_seconds,
  current_time,
  is_paused,
  playback_rate,
  transcript,
  segments,
  markers,
  candidate_markers = EMPTY_MARKERS,
  analysis_strategy,
  marker_error,
  on_scrub,
  on_seek,
  on_toggle_playback,
  on_playback_rate_change,
  on_selected_transcript_indices_change,
  on_add_marker,
  on_update_marker,
  on_delete_marker,
  on_update_transcript,
}: MediaTimelineProps) {
  const timeline_ref = useRef<TimelineState>(null);
  const timeline_host_ref = useRef<HTMLDivElement>(null);
  const pending_wheel_zoom_ref = useRef<TimelineZoomViewport | null>(null);
  const pending_wheel_frame_ref = useRef<number | null>(null);
  const pre_synchronized_scroll_left_ref = useRef<number | null>(null);
  const [viewport, set_viewport] = useState<TimelineViewportState>({
    zoom_pixels_per_second: DEFAULT_ZOOM_PIXELS_PER_SECOND,
    scroll_left: 0,
    scroll_top: 0,
  });
  const viewport_ref = useRef(viewport);
  const [canvas_width, set_canvas_width] = useState(
    DEFAULT_TIMELINE_CANVAS_WIDTH_PIXELS,
  );
  const [selected_marker_id, set_selected_marker_id] = useState<string | null>(
    null,
  );
  const [context_marker_id, set_context_marker_id] = useState<string | null>(
    null,
  );
  const [interaction_revision, set_interaction_revision] = useState(0);
  const [interaction_error, set_interaction_error] = useState<string | null>(
    null,
  );
  const [editing_transcript_index, set_editing_transcript_index] = useState<
    number | null
  >(null);
  const [transcript_draft, set_transcript_draft] = useState("");
  const [transcript_error, set_transcript_error] = useState<string | null>(
    null,
  );
  const [is_saving_transcript, set_is_saving_transcript] = useState(false);
  const [editing_marker_id, set_editing_marker_id] = useState<string | null>(
    null,
  );
  const [marker_start_draft, set_marker_start_draft] = useState(0);
  const [marker_end_draft, set_marker_end_draft] = useState<number | null>(
    null,
  );
  const [marker_save_error, set_marker_save_error] = useState<string | null>(
    null,
  );
  const [is_saving_marker, set_is_saving_marker] = useState(false);
  const [marker_editor_position, set_marker_editor_position] =
    useState<TimelinePointerPosition | null>(null);
  const transcript_segments = useMemo(
    () => transcript?.segments ?? [],
    [transcript],
  );
  const duration = timeline_duration(
    duration_seconds,
    current_time,
    transcript_segments,
    segments,
    [...markers, ...candidate_markers],
  );
  const bounded_time = Math.min(Math.max(current_time, 0), duration);
  const major_scale_seconds = useMemo(
    () => major_scale_interval(viewport.zoom_pixels_per_second),
    [viewport.zoom_pixels_per_second],
  );
  const major_scale_width =
    major_scale_seconds * viewport.zoom_pixels_per_second;
  const max_scale_count = Math.max(
    1,
    Math.ceil(duration / major_scale_seconds),
  );
  const [render_window, set_render_window] = useState<TimelineRenderWindow>(
    () =>
      create_timeline_render_window({
        viewport: {
          zoom_pixels_per_second: DEFAULT_ZOOM_PIXELS_PER_SECOND,
          scroll_left: 0,
        },
        canvas_width: DEFAULT_TIMELINE_CANVAS_WIDTH_PIXELS,
        duration,
      }),
  );
  const visible_render_window = useMemo(
    () =>
      update_timeline_render_window({
        render_window,
        viewport,
        canvas_width,
        duration,
      }),
    [canvas_width, duration, render_window, viewport],
  );
  const render_metrics_ref = useRef({ canvas_width, duration });
  useLayoutEffect(() => {
    render_metrics_ref.current = { canvas_width, duration };
  }, [canvas_width, duration]);
  const full_editor_data = useMemo(
    () =>
      build_timeline_rows({
        transcript_segments,
        segments,
        markers,
        candidate_markers,
        analysis_strategy,
        duration,
        selected_marker_id,
      }),
    // 第三方编辑器会修改 action；保存失败时必须用新对象覆盖其本地变更。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      analysis_strategy,
      candidate_markers,
      duration,
      interaction_revision,
      markers,
      segments,
      selected_marker_id,
      transcript_segments,
    ],
  );
  const editor_data = useMemo(
    () =>
      filter_timeline_rows_for_window(full_editor_data, visible_render_window),
    [full_editor_data, visible_render_window],
  );
  const context_marker = markers.find(
    (marker) => marker.marker_id === context_marker_id,
  );
  const timeline_error = interaction_error ?? transcript_error ?? marker_error;

  const cancel_pending_wheel_zoom = useCallback(() => {
    if (pending_wheel_frame_ref.current !== null) {
      window.cancelAnimationFrame(pending_wheel_frame_ref.current);
    }
    pending_wheel_frame_ref.current = null;
    pending_wheel_zoom_ref.current = null;
  }, []);

  useEffect(() => {
    cancel_pending_wheel_zoom();
    const render_metrics = render_metrics_ref.current;
    const initial_viewport: TimelineViewportState = {
      zoom_pixels_per_second: DEFAULT_ZOOM_PIXELS_PER_SECOND,
      scroll_left: 0,
      scroll_top: 0,
    };
    viewport_ref.current = initial_viewport;
    set_viewport(initial_viewport);
    set_render_window(
      create_timeline_render_window({
        viewport: {
          zoom_pixels_per_second: DEFAULT_ZOOM_PIXELS_PER_SECOND,
          scroll_left: 0,
        },
        canvas_width: render_metrics.canvas_width,
        duration: render_metrics.duration,
      }),
    );
    set_selected_marker_id(null);
    set_context_marker_id(null);
    set_interaction_error(null);
    set_editing_marker_id(null);
    set_marker_editor_position(null);
    set_editing_transcript_index(null);
    set_transcript_draft("");
    set_transcript_error(null);
  }, [asset_id, cancel_pending_wheel_zoom]);

  useEffect(
    () => () => cancel_pending_wheel_zoom(),
    [cancel_pending_wheel_zoom],
  );

  useEffect(() => {
    set_render_window((current) =>
      timeline_render_windows_equal(current, visible_render_window)
        ? current
        : visible_render_window,
    );
  }, [visible_render_window]);

  useLayoutEffect(() => {
    viewport_ref.current = viewport;
    const horizontal_scroll_is_synchronized =
      pre_synchronized_scroll_left_ref.current === viewport.scroll_left;
    pre_synchronized_scroll_left_ref.current = null;
    if (!horizontal_scroll_is_synchronized) {
      timeline_ref.current?.setScrollLeft(viewport.scroll_left);
    }
    timeline_ref.current?.setScrollTop(viewport.scroll_top);
  }, [viewport]);

  useLayoutEffect(() => {
    const timeline_host = timeline_host_ref.current;
    if (!timeline_host) return;

    function measure_canvas_width() {
      const measured_width = timeline_host?.getBoundingClientRect().width ?? 0;
      if (measured_width <= 0) return;
      set_canvas_width((current) =>
        current === measured_width ? current : measured_width,
      );
    }

    measure_canvas_width();
    const resize_observer = new ResizeObserver(measure_canvas_width);
    resize_observer.observe(timeline_host);
    return () => resize_observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const timeline_host = timeline_host_ref.current;
    if (!timeline_host) return;

    // react-virtualized 将自由定位片段错误标成 grid row，需在集成边界修正语义。
    normalize_virtualized_timeline_accessibility(timeline_host);
    const accessibility_observer = new MutationObserver(() =>
      normalize_virtualized_timeline_accessibility(timeline_host),
    );
    accessibility_observer.observe(timeline_host, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["role", "aria-label", "aria-readonly"],
    });
    return () => accessibility_observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    timeline_ref.current?.setTime(bounded_time);
  }, [bounded_time]);

  const add_marker_and_select = useCallback(
    async (
      start_seconds: number,
      end_seconds: number | null = null,
    ): Promise<MediaMarker | undefined> => {
      try {
        const marker = await on_add_marker(
          round_marker_time(start_seconds),
          end_seconds === null ? null : round_marker_time(end_seconds),
        );
        if (marker) set_selected_marker_id(marker.marker_id);
        return marker;
      } catch {
        set_interaction_error("标记添加失败，请稍后重试");
        return undefined;
      }
    },
    [on_add_marker],
  );

  useEffect(() => {
    function handle_marker_shortcut(event: globalThis.KeyboardEvent) {
      if (event.repeat || is_text_editing_target(event.target)) return;
      if (event.ctrlKey && event.key.toLowerCase() === "m") {
        event.preventDefault();
        void add_marker_and_select(bounded_time);
        return;
      }
      if (
        selected_marker_id === null ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        !/^[0-5]$/.test(event.key)
      ) {
        return;
      }
      event.preventDefault();
      void on_update_marker(selected_marker_id, {
        importance: Number(event.key) as MarkerImportance,
      }).catch(() => set_interaction_error("标记评分保存失败，请稍后重试"));
    }

    window.addEventListener("keydown", handle_marker_shortcut);
    return () => window.removeEventListener("keydown", handle_marker_shortcut);
  }, [
    add_marker_and_select,
    bounded_time,
    on_update_marker,
    selected_marker_id,
  ]);

  const commit_zoom_viewport = useCallback(
    (next_viewport: TimelineZoomViewport) => {
      const current = viewport_ref.current;
      if (
        next_viewport.zoom_pixels_per_second ===
          current.zoom_pixels_per_second &&
        next_viewport.scroll_left === current.scroll_left
      ) {
        return;
      }
      const committed_viewport = { ...current, ...next_viewport };
      viewport_ref.current = committed_viewport;
      const timeline = timeline_ref.current;
      if (timeline) {
        // 第三方组件内部持有滚动状态，必须和新比例进入同一批次，避免先用旧位置绘制一帧。
        pre_synchronized_scroll_left_ref.current = next_viewport.scroll_left;
        timeline.setScrollLeft(next_viewport.scroll_left);
      }
      set_viewport(committed_viewport);
    },
    [],
  );

  const zoom_to = useCallback(
    (requested_zoom: number, anchor_x?: number) => {
      cancel_pending_wheel_zoom();
      const measured_width =
        timeline_host_ref.current?.getBoundingClientRect().width ?? 0;
      const viewport_width = measured_width > 0 ? measured_width : canvas_width;
      const next_viewport = calculate_zoom_viewport({
        viewport: viewport_ref.current,
        requested_zoom,
        anchor_x: anchor_x ?? viewport_width / 2,
        viewport_width,
      });
      commit_zoom_viewport(next_viewport);
    },
    [cancel_pending_wheel_zoom, canvas_width, commit_zoom_viewport],
  );

  function zoom_with_alt(event: WheelEvent<HTMLDivElement>) {
    if (!event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const anchor_x = event.clientX - bounds.left;
    const zoom_delta = event.deltaY * ALT_WHEEL_ZOOM_SENSITIVITY;
    const base_viewport =
      pending_wheel_zoom_ref.current ?? viewport_ref.current;
    pending_wheel_zoom_ref.current = calculate_zoom_viewport({
      viewport: base_viewport,
      requested_zoom: base_viewport.zoom_pixels_per_second * (1 + zoom_delta),
      anchor_x,
      viewport_width: bounds.width > 0 ? bounds.width : canvas_width,
    });
    if (pending_wheel_frame_ref.current !== null) return;
    pending_wheel_frame_ref.current = window.requestAnimationFrame(() => {
      const pending_viewport = pending_wheel_zoom_ref.current;
      pending_wheel_frame_ref.current = null;
      pending_wheel_zoom_ref.current = null;
      if (!pending_viewport) return;
      commit_zoom_viewport(pending_viewport);
    });
  }

  function select_action(action: TimelineAction) {
    const media_action = action as MediaTimelineAction;
    const { data } = media_action;
    set_interaction_error(null);
    if (data.kind === "marker" && data.source_id) {
      set_selected_marker_id(data.source_id);
      on_seek(data.marker_anchor_seconds ?? media_action.start);
      cancel_transcript_edit();
      return;
    }
    set_selected_marker_id(null);
    on_seek(media_action.start);
    if (data.kind === "transcript" && data.source_index !== undefined) {
      on_selected_transcript_indices_change([data.source_index]);
    }
  }

  function open_action_editor(
    action: TimelineAction,
    pointer_position: TimelinePointerPosition,
  ) {
    const data = (action as MediaTimelineAction).data;
    if (data.kind === "marker" && data.source_id) {
      edit_marker(data.source_id, pointer_position);
      return;
    }
    if (data.kind === "transcript" && data.source_index !== undefined) {
      on_selected_transcript_indices_change([data.source_index]);
      edit_transcript(data.source_index);
    }
  }

  function prepare_action_context_menu(
    event: MouseEvent<HTMLElement>,
    action: TimelineAction,
  ) {
    const data = (action as MediaTimelineAction).data;
    if (data.kind !== "marker" || !data.source_id) {
      event.preventDefault();
      return;
    }
    set_context_marker_id(data.source_id);
    set_selected_marker_id(data.source_id);
    on_seek(data.marker_anchor_seconds ?? action.start);
  }

  async function persist_marker_bounds(
    action: TimelineAction,
    start_seconds: number,
    end_seconds: number,
    interaction: "move" | "resize",
  ) {
    const data = (action as MediaTimelineAction).data;
    if (data.kind !== "marker" || !data.source_id) return;
    const marker = markers.find((item) => item.marker_id === data.source_id);
    if (!marker) return;

    let next_start = start_seconds;
    let next_end: number | null = end_seconds;
    if (
      data.marker_shape === MARKER_SHAPE_VALUES.point &&
      interaction === "move" &&
      data.marker_anchor_seconds !== undefined &&
      data.rendered_start_seconds !== undefined
    ) {
      const movement = start_seconds - data.rendered_start_seconds;
      next_start = data.marker_anchor_seconds + movement;
      next_end = null;
    }
    next_start = round_marker_time(Math.min(Math.max(next_start, 0), duration));
    if (next_end !== null) {
      next_end = round_marker_time(Math.min(Math.max(next_end, 0), duration));
      if (next_end <= next_start) {
        next_end = Math.min(
          duration,
          next_start + MINIMUM_ACTION_DURATION_SECONDS,
        );
      }
    }

    set_interaction_error(null);
    try {
      await on_update_marker(data.source_id, {
        start_seconds: next_start,
        end_seconds: next_end,
      });
    } catch {
      set_interaction_revision((revision) => revision + 1);
      set_interaction_error("标记时间保存失败，已恢复原位置");
    }
  }

  function render_action(action: TimelineAction) {
    const media_action = action as MediaTimelineAction;
    const marker_anchor_position = marker_anchor_percent(media_action);
    return (
      <button
        type="button"
        className={cn(
          "timeline_action_content",
          `timeline_action_${media_action.data.kind}`,
        )}
        data-shape={media_action.data.marker_shape}
        data-selected={media_action.selected || undefined}
        aria-label={timeline_action_aria_label(media_action)}
        aria-pressed={
          media_action.data.kind === "marker"
            ? Boolean(media_action.selected)
            : undefined
        }
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            const bounds = event.currentTarget.getBoundingClientRect();
            open_action_editor(media_action, {
              x: bounds.left + bounds.width / 2,
              y: bounds.bottom,
            });
            return;
          }
          const opens_context_menu =
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10");
          if (!opens_context_menu) return;
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          event.currentTarget.dispatchEvent(
            new globalThis.MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: bounds.left + bounds.width / 2,
              clientY: bounds.bottom,
            }),
          );
        }}
      >
        {marker_anchor_position !== null ? (
          <span
            className="timeline_action_marker_anchor"
            style={{ left: `${marker_anchor_position}%` }}
            aria-hidden
          />
        ) : null}
        <span className="timeline_action_label" aria-hidden>
          {media_action.data.label}
        </span>
      </button>
    );
  }

  return (
    <section className="media_timeline" aria-label="剪辑时间轴">
      <div className="media_timeline_toolbar" aria-label="时间线工具栏">
        <div className="media_timeline_transport">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={on_toggle_playback}
            aria-label={is_paused ? "播放" : "暂停"}
          >
            {is_paused ? (
              <Play data-icon="inline-start" aria-hidden="true" />
            ) : (
              <Pause data-icon="inline-start" aria-hidden="true" />
            )}
          </Button>
          <output aria-label="当前播放时间和总时长">
            {format_time(bounded_time)} / {format_time(duration)}
          </output>
          <Select
            value={String(playback_rate)}
            onValueChange={(value) => on_playback_rate_change(Number(value))}
          >
            <SelectTrigger
              size="sm"
              aria-label={`播放倍速，当前 ${playback_rate} 倍`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" side="top">
              <SelectGroup>
                {PLAYBACK_RATES.map((rate) => (
                  <SelectItem key={rate} value={String(rate)}>
                    {rate}×
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            aria-label={`在 ${format_time(bounded_time)} 添加标记`}
            title="添加标记（Ctrl+M）"
            onClick={() => void add_marker_and_select(bounded_time)}
          >
            <Flag data-icon="inline-start" aria-hidden="true" />
            <span className="media_timeline_add_label">添加标记</span>
          </Button>
        </div>
        <div className="media_timeline_zoom" aria-label="时间线缩放">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={
              viewport.zoom_pixels_per_second <= MINIMUM_ZOOM_PIXELS_PER_SECOND
            }
            onClick={() =>
              zoom_to(viewport.zoom_pixels_per_second / ZOOM_BUTTON_FACTOR)
            }
            aria-label="缩小时间线"
          >
            <Minus data-icon="inline-start" aria-hidden="true" />
          </Button>
          <Slider
            value={[viewport.zoom_pixels_per_second]}
            min={MINIMUM_ZOOM_PIXELS_PER_SECOND}
            max={MAXIMUM_ZOOM_PIXELS_PER_SECOND}
            step={1}
            onValueChange={([zoom = DEFAULT_ZOOM_PIXELS_PER_SECOND]) =>
              zoom_to(zoom)
            }
            aria-label="时间线缩放比例"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={
              viewport.zoom_pixels_per_second >= MAXIMUM_ZOOM_PIXELS_PER_SECOND
            }
            onClick={() =>
              zoom_to(viewport.zoom_pixels_per_second * ZOOM_BUTTON_FACTOR)
            }
            aria-label="放大时间线"
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => zoom_to(DEFAULT_ZOOM_PIXELS_PER_SECOND)}
            aria-label="重置时间线缩放"
            title="重置为 80 px/s"
          >
            <RotateCcw data-icon="inline-start" aria-hidden="true" />
          </Button>
          <output aria-label="当前时间线缩放">
            {Math.round(viewport.zoom_pixels_per_second)} px/s
          </output>
        </div>
      </div>

      {editing_transcript_index !== null ? (
        <form
          className="media_timeline_editor"
          onSubmit={(event) => void save_transcript(event)}
        >
          <Field className="media_timeline_editor_field">
            <FieldLabel
              htmlFor="timeline-transcript-editor"
              className="sr-only"
            >
              编辑转写文字
            </FieldLabel>
            <Input
              id="timeline-transcript-editor"
              autoFocus
              value={transcript_draft}
              maxLength={10_000}
              onChange={(event) =>
                set_transcript_draft(event.currentTarget.value)
              }
              disabled={is_saving_transcript}
            />
          </Field>
          <Button
            type="submit"
            size="sm"
            disabled={is_saving_transcript || !transcript_draft.trim()}
          >
            {is_saving_transcript ? <Spinner data-icon="inline-start" /> : null}
            {is_saving_transcript ? "保存中…" : "保存"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={cancel_transcript_edit}
            disabled={is_saving_transcript}
          >
            取消
          </Button>
        </form>
      ) : null}

      <Popover
        open={editing_marker_id !== null}
        onOpenChange={(open) => {
          if (!open) cancel_marker_edit();
        }}
      >
        {marker_editor_position ? (
          <PopoverAnchor asChild>
            <span
              className="timeline_marker_editor_anchor pointer-events-none fixed size-px"
              style={{
                left: marker_editor_position.x,
                top: marker_editor_position.y,
              }}
              aria-hidden
            />
          </PopoverAnchor>
        ) : null}
        <PopoverContent
          className="max-h-[var(--radix-popover-content-available-height)] w-[min(30rem,calc(100vw-1rem))] overflow-y-auto p-4"
          side="bottom"
          align="start"
          sideOffset={MARKER_EDITOR_OFFSET}
          collisionPadding={MARKER_EDITOR_COLLISION_PADDING}
        >
          <PopoverHeader>
            <PopoverTitle>编辑标记</PopoverTitle>
            <PopoverDescription>
              调整标记时间、点与范围形态，或删除标记。
            </PopoverDescription>
          </PopoverHeader>
          <form className="flex flex-col gap-4" onSubmit={save_marker}>
            <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="marker-start">开始时间（秒）</FieldLabel>
                <Input
                  id="marker-start"
                  autoFocus
                  type="number"
                  min={0}
                  max={duration}
                  step={MARKER_TIME_STEP_SECONDS}
                  value={marker_start_draft}
                  onChange={(event) =>
                    set_marker_start_draft(event.currentTarget.valueAsNumber)
                  }
                  disabled={is_saving_marker}
                />
              </Field>
              {marker_end_draft !== null ? (
                <Field
                  data-invalid={
                    marker_end_draft <= marker_start_draft || undefined
                  }
                >
                  <FieldLabel htmlFor="marker-end">结束时间（秒）</FieldLabel>
                  <Input
                    id="marker-end"
                    type="number"
                    min={marker_start_draft}
                    max={duration}
                    step={MARKER_TIME_STEP_SECONDS}
                    value={marker_end_draft}
                    aria-invalid={marker_end_draft <= marker_start_draft}
                    onChange={(event) =>
                      set_marker_end_draft(event.currentTarget.valueAsNumber)
                    }
                    disabled={is_saving_marker}
                  />
                  {marker_end_draft <= marker_start_draft ? (
                    <FieldDescription>
                      结束时间必须晚于开始时间。
                    </FieldDescription>
                  ) : null}
                </Field>
              ) : null}
            </FieldGroup>
            <Field className="flex-row items-center justify-between">
              <FieldLabel id="marker-shape-label">标记形态</FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={
                  marker_end_draft === null
                    ? MARKER_SHAPE_VALUES.point
                    : MARKER_SHAPE_VALUES.range
                }
                onValueChange={(value) => {
                  if (!value) return;
                  set_marker_end_draft(
                    value === MARKER_SHAPE_VALUES.range
                      ? Math.min(duration, marker_start_draft + 5)
                      : null,
                  );
                }}
                disabled={is_saving_marker}
                aria-labelledby="marker-shape-label"
              >
                <ToggleGroupItem value={MARKER_SHAPE_VALUES.point}>
                  点标记
                </ToggleGroupItem>
                <ToggleGroupItem value={MARKER_SHAPE_VALUES.range}>
                  范围标记
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>
            {marker_save_error ? (
              <Alert variant="destructive">
                <AlertDescription>{marker_save_error}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={is_saving_marker}
                  >
                    <Trash2 data-icon="inline-start" aria-hidden="true" />
                    删除
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent size="sm">
                  <AlertDialogHeader>
                    <AlertDialogTitle>删除这个标记？</AlertDialogTitle>
                    <AlertDialogDescription>
                      删除后无法恢复，相关评分和范围信息也会一并移除。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={delete_marker}
                    >
                      <Trash2 data-icon="inline-start" aria-hidden="true" />
                      删除标记
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={cancel_marker_edit}
                  disabled={is_saving_marker}
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  disabled={
                    is_saving_marker ||
                    !Number.isFinite(marker_start_draft) ||
                    (marker_end_draft !== null &&
                      (!Number.isFinite(marker_end_draft) ||
                        marker_end_draft <= marker_start_draft))
                  }
                >
                  {is_saving_marker ? (
                    <Spinner data-icon="inline-start" />
                  ) : null}
                  {is_saving_marker ? "保存中…" : "保存"}
                </Button>
              </div>
            </div>
          </form>
        </PopoverContent>
      </Popover>

      <div className="media_timeline_editor_shell">
        <aside className="media_timeline_track_labels" aria-label="时间线轨道">
          <div className="media_timeline_track_labels_header">轨道</div>
          {TIMELINE_TRACK_PRESENTATIONS.map((track) => {
            const TrackIcon = track.icon;
            return (
              <div
                key={track.id}
                className="media_timeline_track_label"
                aria-label={`${track.name}，${track.state}`}
              >
                <TrackIcon aria-hidden="true" />
                <span>{track.name}</span>
                <small>{track.state}</small>
                {track.state === "只读" ? (
                  <LockKeyhole aria-hidden="true" />
                ) : null}
              </div>
            );
          })}
        </aside>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              ref={timeline_host_ref}
              className="media_timeline_canvas"
              tabIndex={0}
              onKeyDown={scrub_with_keyboard}
              onWheelCapture={zoom_with_alt}
              aria-label="时间线画布；双击标记轨道空白处添加标记，Enter 编辑片段，Shift+F10 打开菜单"
            >
              <Timeline
                ref={timeline_ref}
                editorData={editor_data}
                effects={EMPTY_TIMELINE_EFFECTS}
                scale={major_scale_seconds}
                scaleWidth={major_scale_width}
                scaleSplitCount={TIMELINE_SCALE_SPLIT_COUNT}
                minScaleCount={max_scale_count}
                maxScaleCount={max_scale_count}
                startLeft={TIMELINE_START_LEFT}
                rowHeight={TIMELINE_ROW_HEIGHT}
                gridSnap={false}
                dragLine={false}
                autoScroll
                autoReRender={false}
                getScaleRender={(seconds) => format_ruler_time(seconds)}
                getActionRender={render_action}
                onScroll={(next_viewport) => {
                  set_viewport((current) => {
                    if (
                      current.scroll_left === next_viewport.scrollLeft &&
                      current.scroll_top === next_viewport.scrollTop
                    ) {
                      return current;
                    }
                    const updated_viewport = {
                      ...current,
                      scroll_left: next_viewport.scrollLeft,
                      scroll_top: next_viewport.scrollTop,
                    };
                    viewport_ref.current = updated_viewport;
                    return updated_viewport;
                  });
                }}
                onChange={() => false}
                onClickTimeArea={(time) => {
                  on_seek_bounded(time);
                  return true;
                }}
                onCursorDrag={on_scrub_bounded}
                onCursorDragEnd={on_seek_bounded}
                onClickActionOnly={(event, { action }) => {
                  event.stopPropagation();
                  select_action(action);
                }}
                onDoubleClickAction={(event, { action }) => {
                  event.stopPropagation();
                  open_action_editor(action, {
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
                onContextMenuAction={(event, { action }) =>
                  prepare_action_context_menu(event, action)
                }
                onDoubleClickRow={(event, { row, time }) => {
                  if (row.id !== TIMELINE_TRACK_IDS.marker) return;
                  event.preventDefault();
                  void add_marker_and_select(
                    Math.min(Math.max(time, 0), duration),
                  );
                }}
                onActionMoveEnd={({ action, start, end }) => {
                  void persist_marker_bounds(action, start, end, "move");
                }}
                onActionResizeEnd={({ action, start, end }) => {
                  void persist_marker_bounds(action, start, end, "resize");
                }}
              />
            </div>
          </ContextMenuTrigger>
          {context_marker ? (
            <ContextMenuContent className="min-w-48">
              <ContextMenuGroup>
                <ContextMenuLabel>标记重要程度</ContextMenuLabel>
                <ContextMenuRadioGroup
                  value={String(context_marker.importance)}
                  onValueChange={(value) => {
                    void on_update_marker(context_marker.marker_id, {
                      importance: Number(value) as MarkerImportance,
                    }).catch(() =>
                      set_interaction_error("标记评分保存失败，请稍后重试"),
                    );
                  }}
                >
                  {MARKER_IMPORTANCE_VALUES.map((importance) => (
                    <ContextMenuRadioItem
                      key={importance}
                      value={String(importance)}
                    >
                      {format_marker_importance(importance)}
                      <ContextMenuShortcut>{importance}</ContextMenuShortcut>
                    </ContextMenuRadioItem>
                  ))}
                </ContextMenuRadioGroup>
              </ContextMenuGroup>
            </ContextMenuContent>
          ) : null}
        </ContextMenu>
      </div>

      {timeline_error ? (
        <Alert className="media_timeline_error" variant="destructive">
          <AlertDescription>{timeline_error}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );

  function on_seek_bounded(seconds: number) {
    on_seek(Math.min(Math.max(seconds, 0), duration));
  }

  function on_scrub_bounded(seconds: number) {
    on_scrub(Math.min(Math.max(seconds, 0), duration));
  }

  function edit_marker(
    marker_id: string,
    pointer_position: TimelinePointerPosition,
  ) {
    const marker = markers.find(
      (candidate) => candidate.marker_id === marker_id,
    );
    if (!marker) return;
    set_selected_marker_id(marker.marker_id);
    set_editing_marker_id(marker.marker_id);
    set_marker_start_draft(marker.start_seconds);
    set_marker_end_draft(marker.end_seconds);
    set_marker_save_error(null);
    set_marker_editor_position(pointer_position);
    cancel_transcript_edit();
  }

  function edit_transcript(segment_index: number) {
    const segment = transcript_segments[segment_index];
    if (!segment) return;
    cancel_marker_edit();
    set_editing_transcript_index(segment_index);
    set_transcript_draft(segment.text);
    set_transcript_error(null);
  }

  function cancel_transcript_edit() {
    set_editing_transcript_index(null);
    set_transcript_draft("");
    set_transcript_error(null);
  }

  async function save_transcript(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editing_transcript_index === null) return;
    const text = transcript_draft.trim();
    if (!text) return;
    set_is_saving_transcript(true);
    set_transcript_error(null);
    try {
      await on_update_transcript(editing_transcript_index, text);
      cancel_transcript_edit();
    } catch {
      set_transcript_error("转写保存失败，请稍后重试");
    } finally {
      set_is_saving_transcript(false);
    }
  }

  function save_marker(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editing_marker_id === null) return;
    set_is_saving_marker(true);
    set_marker_save_error(null);
    void on_update_marker(editing_marker_id, {
      start_seconds: round_marker_time(marker_start_draft),
      end_seconds:
        marker_end_draft === null ? null : round_marker_time(marker_end_draft),
    })
      .then(cancel_marker_edit)
      .catch(() => set_marker_save_error("标记保存失败，请稍后重试"))
      .finally(() => set_is_saving_marker(false));
  }

  function delete_marker() {
    if (editing_marker_id === null) return;
    set_is_saving_marker(true);
    set_marker_save_error(null);
    void on_delete_marker(editing_marker_id)
      .then(() => {
        set_selected_marker_id(null);
        cancel_marker_edit();
      })
      .catch(() => set_marker_save_error("标记删除失败，请稍后重试"))
      .finally(() => set_is_saving_marker(false));
  }

  function cancel_marker_edit() {
    set_editing_marker_id(null);
    set_marker_start_draft(0);
    set_marker_end_draft(null);
    set_marker_save_error(null);
    set_marker_editor_position(null);
  }

  function scrub_with_keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    on_seek_bounded(bounded_time + direction);
  }
}

function calculate_zoom_viewport({
  viewport,
  requested_zoom,
  anchor_x,
  viewport_width,
}: {
  viewport: TimelineZoomViewport;
  requested_zoom: number;
  anchor_x: number;
  viewport_width: number;
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
  return {
    zoom_pixels_per_second,
    scroll_left: Math.max(
      0,
      anchor_time * zoom_pixels_per_second +
        TIMELINE_START_LEFT -
        bounded_anchor_x,
    ),
  };
}

function create_timeline_render_window({
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

function update_timeline_render_window({
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

function timeline_render_windows_equal(
  first: TimelineRenderWindow,
  second: TimelineRenderWindow,
): boolean {
  return (
    first.start_seconds === second.start_seconds &&
    first.end_seconds === second.end_seconds
  );
}

function filter_timeline_rows_for_window(
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

function build_timeline_rows({
  transcript_segments,
  segments,
  markers,
  candidate_markers,
  analysis_strategy,
  duration,
  selected_marker_id,
}: {
  transcript_segments: Transcript["segments"];
  segments: MediaSegment[];
  markers: MediaMarker[];
  candidate_markers: MediaMarker[];
  analysis_strategy: AnalysisStrategy;
  duration: number;
  selected_marker_id: string | null;
}): TimelineRow[] {
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
  ];
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

function marker_anchor_percent(action: MediaTimelineAction): number | null {
  if (
    action.data.kind !== "marker" ||
    action.data.marker_shape !== MARKER_SHAPE_VALUES.point ||
    action.data.marker_anchor_seconds === undefined
  ) {
    return null;
  }
  const duration = action.end - action.start;
  if (duration <= 0) return null;
  return Math.min(
    100,
    Math.max(
      0,
      ((action.data.marker_anchor_seconds - action.start) / duration) * 100,
    ),
  );
}

function timeline_action_aria_label(action: MediaTimelineAction): string {
  const time_range = `${format_time(action.start)} 至 ${format_time(action.end)}`;
  if (action.data.kind === "candidate") {
    return `${action.data.label}，只读，${time_range}`;
  }
  if (action.data.kind === "transcript") {
    return `转写：${action.data.label}，只读，${time_range}`;
  }
  if (action.data.kind === "event") {
    return `分析事件：${action.data.label}，只读，${time_range}`;
  }
  const shape =
    action.data.marker_shape === MARKER_SHAPE_VALUES.point
      ? "点标记"
      : "范围标记";
  return `${action.data.label}，${shape}，${time_range}`;
}

function major_scale_interval(zoom_pixels_per_second: number): number {
  const target_major_width = 96;
  return MAJOR_SCALE_INTERVALS_SECONDS.reduce((best, interval) => {
    const best_distance = Math.abs(
      best * zoom_pixels_per_second - target_major_width,
    );
    const interval_distance = Math.abs(
      interval * zoom_pixels_per_second - target_major_width,
    );
    return interval_distance < best_distance ? interval : best;
  });
}

function format_ruler_time(seconds: number): string {
  if (seconds < 1) return `${seconds.toFixed(2)}s`;
  return format_time(seconds);
}

function timeline_duration(
  duration_seconds: number | null,
  current_time: number,
  transcript_segments: Transcript["segments"],
  segments: MediaSegment[],
  markers: MediaMarker[],
): number {
  return Math.max(
    duration_seconds ?? 0,
    current_time,
    ...transcript_segments.map((segment) => segment.end_seconds),
    ...segments.map((segment) => segment.end_seconds),
    ...markers.map((marker) => marker.end_seconds ?? marker.start_seconds),
    MINIMUM_DURATION_SECONDS,
  );
}

function round_marker_time(seconds: number): number {
  return Number(
    (
      Math.round(seconds / MARKER_TIME_STEP_SECONDS) * MARKER_TIME_STEP_SECONDS
    ).toFixed(2),
  );
}

function is_text_editing_target(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "input, textarea, [contenteditable]:not([contenteditable='false'])",
    ) !== null
  );
}
