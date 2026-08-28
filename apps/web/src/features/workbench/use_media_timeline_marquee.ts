import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  TIMELINE_RULER_HEIGHT,
  normalize_timeline_marquee_rectangle,
  timeline_marquee_exceeds_drag_threshold,
  type TimelineMarqueePoint,
  type TimelineMarqueeRectangle,
} from "./media_timeline_calculations";

const MARQUEE_DRAG_THRESHOLD_PIXELS = 4;
const TIMELINE_ACTION_SELECTOR =
  ".timeline-editor-action, .timeline_action_content, [data-action-id]";
const TIMELINE_GRID_SELECTOR = ".ReactVirtualized__Grid";

type TimelineMarqueeInteraction = {
  pointer_id: number;
  timeline_host: HTMLDivElement;
  anchor: TimelineMarqueePoint;
  current: TimelineMarqueePoint;
  toggle_selection: boolean;
};

type MediaTimelineMarqueeOptions = {
  on_clear_selection: () => void;
  on_commit_selection: (
    rectangle: TimelineMarqueeRectangle,
    toggle_selection: boolean,
  ) => number;
};

export function use_media_timeline_marquee({
  on_clear_selection,
  on_commit_selection,
}: MediaTimelineMarqueeOptions) {
  const interaction_ref = useRef<TimelineMarqueeInteraction | null>(null);
  const latest_options_ref = useRef({
    on_clear_selection,
    on_commit_selection,
  });
  latest_options_ref.current = {
    on_clear_selection,
    on_commit_selection,
  };
  const [interaction, set_interaction] =
    useState<TimelineMarqueeInteraction | null>(null);
  const [announcement, set_announcement] = useState("");

  useEffect(() => {
    function update_interaction(event: globalThis.PointerEvent) {
      const active_interaction = interaction_ref.current;
      if (
        !active_interaction ||
        event.pointerId !== active_interaction.pointer_id
      )
        return;
      const current = timeline_pointer_position(
        active_interaction.timeline_host,
        event.clientX,
        event.clientY,
      );
      if (!current) return;
      const next_interaction = { ...active_interaction, current };
      interaction_ref.current = next_interaction;
      set_interaction(next_interaction);
      const rectangle = normalize_timeline_marquee_rectangle(
        next_interaction.anchor,
        next_interaction.current,
      );
      if (
        timeline_marquee_exceeds_drag_threshold(
          rectangle,
          MARQUEE_DRAG_THRESHOLD_PIXELS,
        )
      ) {
        event.preventDefault();
      }
    }

    function finish_interaction(event: globalThis.PointerEvent) {
      const active_interaction = interaction_ref.current;
      if (
        !active_interaction ||
        event.pointerId !== active_interaction.pointer_id
      )
        return;
      const current =
        timeline_pointer_position(
          active_interaction.timeline_host,
          event.clientX,
          event.clientY,
        ) ?? active_interaction.current;
      const rectangle = normalize_timeline_marquee_rectangle(
        active_interaction.anchor,
        current,
      );
      interaction_ref.current = null;
      set_interaction(null);

      if (
        !timeline_marquee_exceeds_drag_threshold(
          rectangle,
          MARQUEE_DRAG_THRESHOLD_PIXELS,
        )
      ) {
        latest_options_ref.current.on_clear_selection();
        set_announcement("已清空时间线选择");
        return;
      }

      event.preventDefault();
      const selected_count = latest_options_ref.current.on_commit_selection(
        rectangle,
        active_interaction.toggle_selection,
      );
      set_announcement(`已框选 ${selected_count} 个片段`);
    }

    function cancel_interaction() {
      if (!interaction_ref.current) return;
      interaction_ref.current = null;
      set_interaction(null);
      set_announcement("已取消框选");
    }

    function cancel_pointer_interaction(event: globalThis.PointerEvent) {
      const active_interaction = interaction_ref.current;
      if (
        !active_interaction ||
        event.pointerId !== active_interaction.pointer_id
      )
        return;
      cancel_interaction();
    }

    function cancel_with_keyboard(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || !interaction_ref.current) return;
      event.preventDefault();
      cancel_interaction();
    }

    window.addEventListener("pointermove", update_interaction);
    window.addEventListener("pointerup", finish_interaction);
    window.addEventListener("pointercancel", cancel_pointer_interaction);
    window.addEventListener("keydown", cancel_with_keyboard);
    return () => {
      window.removeEventListener("pointermove", update_interaction);
      window.removeEventListener("pointerup", finish_interaction);
      window.removeEventListener("pointercancel", cancel_pointer_interaction);
      window.removeEventListener("keydown", cancel_with_keyboard);
    };
  }, []);

  function start_marquee(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      event.button !== 0 ||
      is_timeline_action_target(event.target) ||
      is_scrollbar_pointer(event.target, event.clientX, event.clientY)
    ) {
      return;
    }
    const anchor = timeline_pointer_position(
      event.currentTarget,
      event.clientX,
      event.clientY,
    );
    if (!anchor || anchor.y <= TIMELINE_RULER_HEIGHT) return;
    const next_interaction = {
      pointer_id: event.pointerId,
      timeline_host: event.currentTarget,
      anchor,
      current: anchor,
      toggle_selection: event.ctrlKey || event.metaKey,
    };
    interaction_ref.current = next_interaction;
    set_interaction(next_interaction);
    set_announcement("");
  }

  const rectangle = interaction
    ? normalize_timeline_marquee_rectangle(
        interaction.anchor,
        interaction.current,
      )
    : null;
  const visible_rectangle =
    rectangle &&
    timeline_marquee_exceeds_drag_threshold(
      rectangle,
      MARQUEE_DRAG_THRESHOLD_PIXELS,
    )
      ? rectangle
      : null;

  return {
    announcement,
    marquee_rectangle: visible_rectangle,
    start_marquee,
  };
}

function timeline_pointer_position(
  timeline_host: HTMLDivElement | null,
  client_x: number,
  client_y: number,
): TimelineMarqueePoint | null {
  if (!timeline_host) return null;
  const bounds = timeline_host.getBoundingClientRect();
  return {
    x: Math.min(Math.max(client_x - bounds.left, 0), bounds.width),
    y: Math.min(
      Math.max(client_y - bounds.top, TIMELINE_RULER_HEIGHT),
      bounds.height,
    ),
  };
}

function is_timeline_action_target(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(TIMELINE_ACTION_SELECTOR) !== null
  );
}

function is_scrollbar_pointer(
  target: EventTarget | null,
  client_x: number,
  client_y: number,
): boolean {
  if (!(target instanceof Element)) return false;
  const grid = target.closest<HTMLElement>(TIMELINE_GRID_SELECTOR);
  if (!grid) return false;
  const bounds = grid.getBoundingClientRect();
  const points_at_vertical_scrollbar =
    grid.offsetWidth > grid.clientWidth &&
    client_x >= bounds.left + grid.clientWidth;
  const points_at_horizontal_scrollbar =
    grid.offsetHeight > grid.clientHeight &&
    client_y >= bounds.top + grid.clientHeight;
  return points_at_vertical_scrollbar || points_at_horizontal_scrollbar;
}
