import type { TimelineEditor } from "@xzdarcy/react-timeline-editor";

import { cn } from "@/lib/utils";
import { format_time } from "@/shared/format";
import {
  MARKER_SHAPE_VALUES,
  type MediaTimelineAction,
} from "./media_timeline_calculations";

type TimelineAction = TimelineEditor["editorData"][number]["actions"][number];

type MediaTimelineActionContentProps = {
  action: TimelineAction;
  open_action_editor: (
    action: TimelineAction,
    pointer_position: { x: number; y: number },
  ) => void;
};

export function MediaTimelineActionContent({
  action,
  open_action_editor,
}: MediaTimelineActionContentProps) {
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
      aria-pressed={Boolean(media_action.selected)}
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
    return `全片分析：${action.data.label}，只读，${time_range}`;
  }
  if (action.data.kind === "focus") {
    return `焦点选区：${action.data.label}，只读，${time_range}`;
  }
  if (action.data.kind === "event_analysis") {
    return `事件分析：${action.data.label}，只读，${time_range}`;
  }
  const shape =
    action.data.marker_shape === MARKER_SHAPE_VALUES.point
      ? "点标记"
      : "范围标记";
  return `${action.data.label}，${shape}，${time_range}`;
}
