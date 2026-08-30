import type { TimelineState } from "@xzdarcy/react-timeline-editor";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  DEFAULT_ZOOM_PIXELS_PER_SECOND,
  TIMELINE_START_LEFT,
  calculate_playhead_follow_scroll_left,
  calculate_zoom_viewport,
  consume_timeline_wheel_zoom_frame,
  create_timeline_render_window,
  extend_timeline_render_window,
  normalize_wheel_delta,
  timeline_render_windows_equal,
  update_timeline_render_window,
  type TimelineViewportState,
  type TimelineWheelZoomEvent,
  type TimelineZoomViewport,
} from "./media_timeline_calculations";

const ALT_WHEEL_ZOOM_SENSITIVITY = -0.001;
const WHEEL_ZOOM_IDLE_MILLISECONDS = 100;
const DEFAULT_TIMELINE_CANVAS_WIDTH_PIXELS = 1024;
const SCROLL_SYNC_EPSILON_PIXELS = 0.5;
const VIRTUALIZED_GRID_SELECTOR = ".ReactVirtualized__Grid";
const VIRTUALIZED_GRID_ROLE_SELECTOR = '[role="row"], [role="gridcell"]';

type TimelineScrollPosition = {
  scrollLeft: number;
  scrollTop: number;
};

type MediaTimelineViewportOptions = {
  asset_id: string | null;
  bounded_time: number;
  duration: number;
  is_paused: boolean;
  playback_rate: number;
  read_playback_time?: () => number;
};

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

function scroll_positions_differ(first: number, second: number) {
  return Math.abs(first - second) > SCROLL_SYNC_EPSILON_PIXELS;
}

export function use_media_timeline_viewport({
  asset_id,
  bounded_time,
  duration,
  is_paused,
  playback_rate,
  read_playback_time,
}: MediaTimelineViewportOptions) {
  const timeline_ref = useRef<TimelineState>(null);
  const timeline_host_ref = useRef<HTMLDivElement>(null);
  const playhead_ref = useRef<HTMLDivElement>(null);
  const playhead_frame_ref = useRef<number | null>(null);
  const playhead_anchor_ref = useRef({
    media_time: bounded_time,
    frame_time: performance.now(),
  });
  const playhead_time_ref = useRef(bounded_time);
  const previous_bounded_time_ref = useRef(bounded_time);
  const playback_metrics_ref = useRef({ duration, playback_rate });
  const playback_time_reader_ref = useRef(read_playback_time);
  const pending_wheel_events_ref = useRef<TimelineWheelZoomEvent[]>([]);
  const pending_wheel_frame_ref = useRef<number | null>(null);
  const pending_wheel_idle_ref = useRef<number | null>(null);
  const pending_scroll_frame_ref = useRef<number | null>(null);
  const pending_scroll_position_ref = useRef<TimelineScrollPosition | null>(
    null,
  );
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
  const [render_window, set_render_window] = useState(() =>
    create_timeline_render_window({
      viewport: {
        zoom_pixels_per_second: DEFAULT_ZOOM_PIXELS_PER_SECOND,
        scroll_left: 0,
      },
      canvas_width: DEFAULT_TIMELINE_CANVAS_WIDTH_PIXELS,
      duration,
    }),
  );
  const render_metrics_ref = useRef({ canvas_width, duration });
  const wheel_zoom_is_active =
    pending_wheel_frame_ref.current !== null ||
    pending_wheel_idle_ref.current !== null ||
    pending_wheel_events_ref.current.length > 0;
  const editor_render_window = useMemo(() => {
    const parameters = { render_window, viewport, canvas_width, duration };
    return wheel_zoom_is_active
      ? extend_timeline_render_window(parameters)
      : update_timeline_render_window(parameters);
  }, [canvas_width, duration, render_window, viewport, wheel_zoom_is_active]);

  const position_playhead = useCallback((time: number) => {
    const playhead = playhead_ref.current;
    if (!playhead) return;
    const current_viewport = viewport_ref.current;
    const playhead_x =
      TIMELINE_START_LEFT +
      time * current_viewport.zoom_pixels_per_second -
      current_viewport.scroll_left;
    playhead.style.transform = `translate3d(${playhead_x}px, 0, 0)`;
    const is_visible =
      playhead_x >= 0 && playhead_x <= render_metrics_ref.current.canvas_width;
    const visibility = String(is_visible);
    if (playhead.dataset.visible !== visibility) {
      playhead.dataset.visible = visibility;
    }
  }, []);

  const set_playhead_time = useCallback(
    (time: number, follow_viewport = false) => {
      playhead_time_ref.current = time;
      const wheel_frame_is_pending =
        pending_wheel_frame_ref.current !== null ||
        pending_wheel_events_ref.current.length > 0;
      if (follow_viewport && !wheel_frame_is_pending) {
        const current_viewport = viewport_ref.current;
        const next_scroll_left = calculate_playhead_follow_scroll_left({
          time,
          viewport: current_viewport,
          viewport_width: render_metrics_ref.current.canvas_width,
          scale_count: Math.ceil(render_metrics_ref.current.duration),
        });
        if (
          next_scroll_left !== null &&
          scroll_positions_differ(
            current_viewport.scroll_left,
            next_scroll_left,
          )
        ) {
          const next_viewport = {
            ...current_viewport,
            scroll_left: next_scroll_left,
          };
          viewport_ref.current = next_viewport;
          set_viewport(next_viewport);
        }
      }
      position_playhead(time);
    },
    [position_playhead],
  );

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

  const cancel_pending_scroll = useCallback(() => {
    if (pending_scroll_frame_ref.current !== null) {
      window.cancelAnimationFrame(pending_scroll_frame_ref.current);
    }
    pending_scroll_frame_ref.current = null;
    pending_scroll_position_ref.current = null;
  }, []);

  const commit_pending_scroll = useCallback(() => {
    if (pending_scroll_frame_ref.current !== null) {
      window.cancelAnimationFrame(pending_scroll_frame_ref.current);
    }
    pending_scroll_frame_ref.current = null;
    const pending_position = pending_scroll_position_ref.current;
    pending_scroll_position_ref.current = null;
    if (!pending_position) return;
    set_viewport((current) => {
      if (
        current.scroll_left === pending_position.scrollLeft &&
        current.scroll_top === pending_position.scrollTop
      ) {
        return current;
      }
      const updated_viewport = {
        ...current,
        scroll_left: pending_position.scrollLeft,
        scroll_top: pending_position.scrollTop,
      };
      viewport_ref.current = updated_viewport;
      return updated_viewport;
    });
  }, []);

  useLayoutEffect(() => {
    render_metrics_ref.current = { canvas_width, duration };
  }, [canvas_width, duration]);

  useLayoutEffect(() => {
    playback_time_reader_ref.current = read_playback_time;
  }, [read_playback_time]);

  useLayoutEffect(() => {
    playback_metrics_ref.current.duration = duration;
    playhead_anchor_ref.current = {
      media_time: bounded_time,
      frame_time: performance.now(),
    };
    const should_follow_viewport =
      bounded_time !== previous_bounded_time_ref.current;
    previous_bounded_time_ref.current = bounded_time;
    set_playhead_time(bounded_time, should_follow_viewport);
  }, [bounded_time, duration, set_playhead_time]);

  useLayoutEffect(() => {
    playback_metrics_ref.current.playback_rate = playback_rate;
    playhead_anchor_ref.current = {
      media_time: playhead_time_ref.current,
      frame_time: performance.now(),
    };
  }, [playback_rate]);

  useEffect(() => {
    cancel_pending_wheel_zoom();
    cancel_pending_scroll();
    const initial_viewport: TimelineViewportState = {
      zoom_pixels_per_second: DEFAULT_ZOOM_PIXELS_PER_SECOND,
      scroll_left: 0,
      scroll_top: 0,
    };
    viewport_ref.current = initial_viewport;
    set_viewport(initial_viewport);
    set_render_window(
      create_timeline_render_window({
        viewport: initial_viewport,
        canvas_width: render_metrics_ref.current.canvas_width,
        duration: render_metrics_ref.current.duration,
      }),
    );
  }, [asset_id, cancel_pending_scroll, cancel_pending_wheel_zoom]);

  useEffect(() => {
    return () => {
      cancel_pending_scroll();
      cancel_pending_wheel_zoom();
    };
  }, [cancel_pending_scroll, cancel_pending_wheel_zoom]);

  useEffect(() => {
    if (is_paused) {
      const reported_time = playback_time_reader_ref.current?.();
      if (typeof reported_time === "number" && Number.isFinite(reported_time)) {
        const bounded_reported_time = Math.min(
          playback_metrics_ref.current.duration,
          Math.max(0, reported_time),
        );
        set_playhead_time(bounded_reported_time);
      }
      return;
    }

    playhead_anchor_ref.current = {
      media_time: playhead_time_ref.current,
      frame_time: performance.now(),
    };

    function animate_playhead(frame_time: number) {
      const anchor = playhead_anchor_ref.current;
      const metrics = playback_metrics_ref.current;
      const elapsed_seconds = Math.max(
        0,
        (frame_time - anchor.frame_time) / 1_000,
      );
      const fallback_time = Math.min(
        metrics.duration,
        anchor.media_time + elapsed_seconds * metrics.playback_rate,
      );
      const reported_time = playback_time_reader_ref.current?.();
      const playback_time =
        typeof reported_time === "number" && Number.isFinite(reported_time)
          ? Math.min(metrics.duration, Math.max(0, reported_time))
          : fallback_time;
      set_playhead_time(playback_time, true);
      if (playback_time >= metrics.duration) {
        playhead_frame_ref.current = null;
        return;
      }
      playhead_frame_ref.current =
        window.requestAnimationFrame(animate_playhead);
    }

    playhead_frame_ref.current = window.requestAnimationFrame(animate_playhead);
    return () => {
      if (playhead_frame_ref.current !== null) {
        window.cancelAnimationFrame(playhead_frame_ref.current);
        playhead_frame_ref.current = null;
      }
    };
  }, [asset_id, is_paused, set_playhead_time]);

  useLayoutEffect(() => {
    set_render_window((current) =>
      timeline_render_windows_equal(current, editor_render_window)
        ? current
        : editor_render_window,
    );
  }, [editor_render_window]);

  useLayoutEffect(() => {
    viewport_ref.current = viewport;
    const timeline = timeline_ref.current;
    if (
      timeline &&
      scroll_positions_differ(
        synchronized_scroll_ref.current.scroll_left,
        viewport.scroll_left,
      )
    ) {
      synchronized_scroll_ref.current.scroll_left = viewport.scroll_left;
      timeline.setScrollLeft(viewport.scroll_left);
    }
    if (
      timeline &&
      scroll_positions_differ(
        synchronized_scroll_ref.current.scroll_top,
        viewport.scroll_top,
      )
    ) {
      synchronized_scroll_ref.current.scroll_top = viewport.scroll_top;
      timeline.setScrollTop(viewport.scroll_top);
    }
    position_playhead(playhead_time_ref.current);
  }, [position_playhead, viewport]);

  useLayoutEffect(() => {
    const timeline_host = timeline_host_ref.current;
    if (!timeline_host) return;
    const timeline_element = timeline_host;

    function measure_canvas_width() {
      const measured_width = timeline_element.getBoundingClientRect().width;
      if (measured_width <= 0) return;
      set_canvas_width((current) =>
        current === measured_width ? current : measured_width,
      );
    }

    measure_canvas_width();
    const resize_observer = new ResizeObserver(measure_canvas_width);
    resize_observer.observe(timeline_element);
    return () => resize_observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const timeline_host = timeline_host_ref.current;
    if (!timeline_host) return;

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
      set_viewport(committed_viewport);
    },
    [],
  );

  const zoom_to = useCallback(
    (requested_zoom: number, anchor_x?: number) => {
      commit_pending_scroll();
      cancel_pending_wheel_zoom();
      const measured_width =
        timeline_host_ref.current?.getBoundingClientRect().width ?? 0;
      const viewport_width = measured_width > 0 ? measured_width : canvas_width;
      const scale_count = Math.ceil(render_metrics_ref.current.duration);
      const next_viewport = calculate_zoom_viewport({
        viewport: viewport_ref.current,
        requested_zoom,
        anchor_x: anchor_x ?? viewport_width / 2,
        viewport_width,
        scale_count,
      });
      commit_zoom_viewport(next_viewport);
    },
    [
      cancel_pending_wheel_zoom,
      canvas_width,
      commit_pending_scroll,
      commit_zoom_viewport,
    ],
  );

  useEffect(() => {
    const timeline_host = timeline_host_ref.current;
    if (!timeline_host) return;
    const timeline_element = timeline_host;

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
        const settled_window = create_timeline_render_window({
          viewport: viewport_ref.current,
          canvas_width: render_metrics_ref.current.canvas_width,
          duration: render_metrics_ref.current.duration,
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
      const scale_count = Math.ceil(render_metrics_ref.current.duration);
      const frame_result = consume_timeline_wheel_zoom_frame({
        viewport: viewport_ref.current,
        events: pending_wheel_events_ref.current,
        scale_count,
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

    function zoom_with_alt(event: globalThis.WheelEvent) {
      if (!event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      commit_pending_scroll();
      const bounds = timeline_element.getBoundingClientRect();
      const viewport_width =
        bounds.width > 0
          ? bounds.width
          : render_metrics_ref.current.canvas_width;
      const page_height =
        bounds.height > 0 ? bounds.height : window.innerHeight;
      const normalized_delta = normalize_wheel_delta(
        event.deltaY,
        event.deltaMode,
        page_height,
      );
      pending_wheel_events_ref.current.push({
        logarithmic_delta: normalized_delta * ALT_WHEEL_ZOOM_SENSITIVITY,
        anchor_x: event.clientX - bounds.left,
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

    timeline_element.addEventListener("wheel", zoom_with_alt, {
      capture: true,
      passive: false,
    });
    return () =>
      timeline_element.removeEventListener("wheel", zoom_with_alt, true);
  }, [commit_pending_scroll, commit_zoom_viewport]);

  function handle_timeline_scroll(position: TimelineScrollPosition) {
    synchronized_scroll_ref.current = {
      scroll_left: position.scrollLeft,
      scroll_top: position.scrollTop,
    };
    const latest_viewport = {
      ...viewport_ref.current,
      scroll_left: position.scrollLeft,
      scroll_top: position.scrollTop,
    };
    viewport_ref.current = latest_viewport;
    pending_scroll_position_ref.current = position;
    if (pending_scroll_frame_ref.current !== null) return;

    pending_scroll_frame_ref.current = window.requestAnimationFrame(
      commit_pending_scroll,
    );
  }

  return {
    canvas_width,
    editor_render_window,
    handle_timeline_scroll,
    playhead_ref,
    set_playhead_time,
    timeline_host_ref,
    timeline_ref,
    viewport,
    zoom_to,
  };
}
