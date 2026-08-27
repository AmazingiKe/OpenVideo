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
  ScanSearch,
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
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { format_marker_importance } from "@/shared/marker_labels";
import type {
  AnalysisStrategy,
  MarkerImportance,
  MediaMarker,
  MediaMarkerUpdate,
  MediaSegment,
  Transcript,
} from "@/shared/types";
import { TimelineRulerCanvas } from "./TimelineRulerCanvas";
import { MediaTimelineMarkerEditor } from "./MediaTimelineMarkerEditor";
import { MediaTimelineActionContent } from "./MediaTimelineActionContent";
import { MediaTimelineToolbar } from "./MediaTimelineToolbar";
import { MediaTimelineTranscriptEditor } from "./MediaTimelineTranscriptEditor";
import {
  DEFAULT_ZOOM_PIXELS_PER_SECOND,
  MARKER_SHAPE_VALUES,
  MINIMUM_ACTION_DURATION_SECONDS,
  TIMELINE_ROW_HEIGHT,
  TIMELINE_START_LEFT,
  TIMELINE_TRACK_IDS,
  build_timeline_rows,
  calculate_zoom_viewport,
  consume_timeline_wheel_zoom_frame,
  create_timeline_render_window,
  extend_timeline_render_window,
  filter_timeline_rows_for_window,
  normalize_wheel_delta,
  round_marker_time,
  timeline_content_duration,
  timeline_render_windows_equal,
  update_timeline_render_window,
  type MediaTimelineAction,
  type TimelineAction,
  type TimelineRenderWindow,
  type TimelineViewportState,
  type TimelineWheelZoomEvent,
  type TimelineZoomViewport,
} from "./media_timeline_calculations";

const ALT_WHEEL_ZOOM_SENSITIVITY = -0.001;
const WHEEL_ZOOM_IDLE_MILLISECONDS = 100;
const TIMELINE_SCALE_SECONDS = 1;
const TIMELINE_SCALE_SPLIT_COUNT = 1;
const DEFAULT_TIMELINE_CANVAS_WIDTH_PIXELS = 1024;
const VIRTUALIZED_GRID_SELECTOR = ".ReactVirtualized__Grid";
const VIRTUALIZED_GRID_ROLE_SELECTOR = '[role="row"], [role="gridcell"]';
const EMPTY_MARKERS: MediaMarker[] = [];
const EMPTY_TIMELINE_EFFECTS: TimelineEditor["effects"] = {};
const MARKER_IMPORTANCE_VALUES: MarkerImportance[] = [0, 1, 2, 3, 4, 5];

function normalize_virtualized_timeline_accessibility(root: Element) {
  const grids = root.matches(VIRTUALIZED_GRID_SELECTOR)
    ? [root]
    : [...root.querySelectorAll(VIRTUALIZED_GRID_SELECTOR)];
  for (const grid of grids) {
    grid.setAttribute("role", "group");
    grid.setAttribute("aria-label", "时间线轨道内容");
    grid.removeAttribute("aria-readonly");
  }

  const role_elements = root.matches(VIRTUALIZED_GRID_ROLE_SELECTOR)
    ? [root]
    : [...root.querySelectorAll(VIRTUALIZED_GRID_ROLE_SELECTOR)];
  for (const element of role_elements) element.removeAttribute("role");
}

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
  const pending_wheel_events_ref = useRef<TimelineWheelZoomEvent[]>([]);
  const pending_wheel_frame_ref = useRef<number | null>(null);
  const pending_wheel_idle_ref = useRef<number | null>(null);
  const synchronized_scroll_ref = useRef({ scroll_left: 0, scroll_top: 0 });
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
  const content_duration = useMemo(
    () =>
      timeline_content_duration(
        duration_seconds,
        transcript_segments,
        segments,
        markers,
        candidate_markers,
      ),
    [
      candidate_markers,
      duration_seconds,
      markers,
      segments,
      transcript_segments,
    ],
  );
  const duration = Math.max(content_duration, current_time);
  const bounded_time = Math.min(Math.max(current_time, 0), duration);
  const scale_count = Math.max(1, Math.ceil(duration));
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
  const wheel_zoom_is_active =
    pending_wheel_frame_ref.current !== null ||
    pending_wheel_idle_ref.current !== null ||
    pending_wheel_events_ref.current.length > 0;
  const editor_render_window = useMemo(() => {
    const render_window_parameters = {
      render_window,
      viewport,
      canvas_width,
      duration,
    };
    return wheel_zoom_is_active
      ? extend_timeline_render_window(render_window_parameters)
      : update_timeline_render_window(render_window_parameters);
  }, [canvas_width, duration, render_window, viewport, wheel_zoom_is_active]);
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
      filter_timeline_rows_for_window(full_editor_data, editor_render_window),
    [editor_render_window, full_editor_data],
  );
  const context_marker = markers.find(
    (marker) => marker.marker_id === context_marker_id,
  );
  const timeline_error = interaction_error ?? transcript_error ?? marker_error;

  const cancel_pending_wheel_zoom = useCallback(() => {
    if (pending_wheel_frame_ref.current !== null) {
      window.cancelAnimationFrame(pending_wheel_frame_ref.current);
    }
    if (pending_wheel_idle_ref.current !== null) {
      window.clearTimeout(pending_wheel_idle_ref.current);
    }
    pending_wheel_frame_ref.current = null;
    pending_wheel_idle_ref.current = null;
    pending_wheel_events_ref.current = [];
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

  useLayoutEffect(() => {
    set_render_window((current) =>
      timeline_render_windows_equal(current, editor_render_window)
        ? current
        : editor_render_window,
    );
  }, [editor_render_window]);

  useLayoutEffect(() => {
    viewport_ref.current = viewport;
    if (synchronized_scroll_ref.current.scroll_left !== viewport.scroll_left) {
      timeline_ref.current?.setScrollLeft(viewport.scroll_left);
      synchronized_scroll_ref.current.scroll_left = viewport.scroll_left;
    }
    if (synchronized_scroll_ref.current.scroll_top !== viewport.scroll_top) {
      timeline_ref.current?.setScrollTop(viewport.scroll_top);
      synchronized_scroll_ref.current.scroll_top = viewport.scroll_top;
    }
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
    const accessibility_observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) {
            normalize_virtualized_timeline_accessibility(node);
          }
        }
      }
    });
    accessibility_observer.observe(timeline_host, {
      subtree: true,
      childList: true,
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
      if (
        timeline &&
        synchronized_scroll_ref.current.scroll_left !==
          next_viewport.scroll_left
      ) {
        // 第三方组件内部持有滚动状态，必须和新比例进入同一批次，避免先用旧位置绘制一帧。
        timeline.setScrollLeft(next_viewport.scroll_left);
        synchronized_scroll_ref.current.scroll_left = next_viewport.scroll_left;
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

  function settle_render_window_after_wheel() {
    if (pending_wheel_idle_ref.current !== null) {
      window.clearTimeout(pending_wheel_idle_ref.current);
    }
    pending_wheel_idle_ref.current = window.setTimeout(() => {
      pending_wheel_idle_ref.current = null;
      if (
        pending_wheel_frame_ref.current !== null ||
        pending_wheel_events_ref.current.length > 0
      ) {
        return;
      }
      const render_metrics = render_metrics_ref.current;
      const settled_window = create_timeline_render_window({
        viewport: viewport_ref.current,
        canvas_width: render_metrics.canvas_width,
        duration: render_metrics.duration,
      });
      set_render_window((current) =>
        timeline_render_windows_equal(current, settled_window)
          ? current
          : settled_window,
      );
    }, WHEEL_ZOOM_IDLE_MILLISECONDS);
  }

  function flush_pending_wheel_zoom() {
    pending_wheel_frame_ref.current = null;
    const frame_result = consume_timeline_wheel_zoom_frame({
      viewport: viewport_ref.current,
      events: pending_wheel_events_ref.current,
    });
    pending_wheel_events_ref.current = frame_result.remaining_events;
    commit_zoom_viewport(frame_result.viewport);

    if (pending_wheel_events_ref.current.length > 0) {
      pending_wheel_frame_ref.current = window.requestAnimationFrame(
        flush_pending_wheel_zoom,
      );
      return;
    }
    settle_render_window_after_wheel();
  }

  function zoom_with_alt(event: WheelEvent<HTMLDivElement>) {
    if (!event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const anchor_x = event.clientX - bounds.left;
    const viewport_width = bounds.width > 0 ? bounds.width : canvas_width;
    const page_height = bounds.height > 0 ? bounds.height : window.innerHeight;
    const normalized_delta = normalize_wheel_delta(
      event.deltaY,
      event.deltaMode,
      page_height,
    );
    pending_wheel_events_ref.current.push({
      logarithmic_delta: normalized_delta * ALT_WHEEL_ZOOM_SENSITIVITY,
      anchor_x,
      viewport_width,
    });
    if (pending_wheel_idle_ref.current !== null) {
      window.clearTimeout(pending_wheel_idle_ref.current);
      pending_wheel_idle_ref.current = null;
    }
    if (pending_wheel_frame_ref.current !== null) return;
    pending_wheel_frame_ref.current = window.requestAnimationFrame(
      flush_pending_wheel_zoom,
    );
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

  return (
    <section className="media_timeline" aria-label="剪辑时间轴">
      <MediaTimelineToolbar
        current_time={bounded_time}
        duration={duration}
        is_paused={is_paused}
        playback_rate={playback_rate}
        zoom_pixels_per_second={viewport.zoom_pixels_per_second}
        on_toggle_playback={on_toggle_playback}
        on_playback_rate_change={on_playback_rate_change}
        on_add_marker={(seconds) => void add_marker_and_select(seconds)}
        on_zoom_change={zoom_to}
      />

      <MediaTimelineTranscriptEditor
        editing_transcript_index={editing_transcript_index}
        transcript_draft={transcript_draft}
        is_saving_transcript={is_saving_transcript}
        set_transcript_draft={set_transcript_draft}
        save_transcript={save_transcript}
        cancel_transcript_edit={cancel_transcript_edit}
      />

      <MediaTimelineMarkerEditor
        editing_marker_id={editing_marker_id}
        marker_editor_position={marker_editor_position}
        duration={duration}
        marker_start_draft={marker_start_draft}
        marker_end_draft={marker_end_draft}
        marker_save_error={marker_save_error}
        is_saving_marker={is_saving_marker}
        set_marker_start_draft={set_marker_start_draft}
        set_marker_end_draft={set_marker_end_draft}
        cancel_marker_edit={cancel_marker_edit}
        save_marker={save_marker}
        delete_marker={delete_marker}
      />

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
              <TimelineRulerCanvas
                canvas_width={canvas_width}
                duration_seconds={duration}
                scroll_left={viewport.scroll_left}
                start_left={TIMELINE_START_LEFT}
                zoom_pixels_per_second={viewport.zoom_pixels_per_second}
              />
              <Timeline
                ref={timeline_ref}
                editorData={editor_data}
                effects={EMPTY_TIMELINE_EFFECTS}
                scale={TIMELINE_SCALE_SECONDS}
                scaleWidth={viewport.zoom_pixels_per_second}
                scaleSplitCount={TIMELINE_SCALE_SPLIT_COUNT}
                minScaleCount={scale_count}
                maxScaleCount={scale_count}
                startLeft={TIMELINE_START_LEFT}
                rowHeight={TIMELINE_ROW_HEIGHT}
                gridSnap={false}
                dragLine={false}
                autoScroll
                autoReRender={false}
                getActionRender={(action) => (
                  <MediaTimelineActionContent
                    action={action}
                    open_action_editor={open_action_editor}
                  />
                )}
                onScroll={(next_viewport) => {
                  synchronized_scroll_ref.current = {
                    scroll_left: next_viewport.scrollLeft,
                    scroll_top: next_viewport.scrollTop,
                  };
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

function is_text_editing_target(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "input, textarea, [contenteditable]:not([contenteditable='false'])",
    ) !== null
  );
}
