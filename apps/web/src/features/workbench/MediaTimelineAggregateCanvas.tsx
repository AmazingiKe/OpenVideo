import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { format_time } from "@/shared/format";
import type {
  TimelineAggregate,
  MediaTimelineAction,
  TimelineSelectionRange,
} from "./media_timeline_calculations";

type TimelineAggregatePaintStyle = {
  border_colors: Record<MediaTimelineAction["data"]["kind"], string>;
  radius: number;
  border: number;
  selection_width: number;
  label_padding: number;
  block_colors: Record<MediaTimelineAction["data"]["kind"], string>;
  selection_color: string;
  label_color: string;
  font: string;
  count_font: string;
};

type MediaTimelineAggregateCanvasProps = {
  aggregates: TimelineAggregate[];
  canvas_width: number;
  scroll_left: number;
  scroll_top: number;
  on_select: (members: MediaTimelineAction[], toggle: boolean) => void;
  on_zoom: (range: TimelineSelectionRange) => void;
};

export const MediaTimelineAggregateCanvas = memo(
  function MediaTimelineAggregateCanvas({
    aggregates,
    canvas_width,
    scroll_left,
    scroll_top,
    on_select,
    on_zoom,
  }: MediaTimelineAggregateCanvasProps) {
    const canvas_ref = useRef<HTMLCanvasElement>(null);
    const paint_style_ref = useRef<TimelineAggregatePaintStyle | null>(null);
    const [canvas_height, set_canvas_height] = useState(0);
    const [block_inset, set_block_inset] = useState(0);
    useLayoutEffect(() => {
      const canvas = canvas_ref.current;
      if (!canvas) return;
      set_block_inset(
        parseFloat(
          getComputedStyle(canvas).getPropertyValue("--timeline-block-inset"),
        ),
      );
      const measure = () =>
        set_canvas_height(canvas.getBoundingClientRect().height);
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(canvas);
      return () => observer.disconnect();
    }, []);
    const blocks = useMemo(
      () =>
        aggregates.flatMap((group) => {
          const left = Math.max(0, group.left - scroll_left);
          const right = Math.min(canvas_width, group.right - scroll_left);
          const top = group.top + block_inset - scroll_top;
          const height = Math.max(1, group.height - block_inset * 2);
          if (
            right <= left ||
            top + height < 0 ||
            (canvas_height > 0 && top > canvas_height)
          )
            return [];
          return [{ group, left, width: right - left, top, height }];
        }),
      [
        aggregates,
        canvas_width,
        canvas_height,
        scroll_left,
        scroll_top,
        block_inset,
      ],
    );

    useLayoutEffect(() => {
      const canvas = canvas_ref.current;
      if (!canvas || canvas_width <= 0) return;
      const context = canvas.getContext("2d");
      if (!context) return;
      const device_pixel_ratio = Math.max(window.devicePixelRatio || 1, 1);
      canvas.width = Math.max(1, Math.round(canvas_width * device_pixel_ratio));
      canvas.height = Math.max(
        1,
        Math.round(canvas_height * device_pixel_ratio),
      );
      let paint_style = paint_style_ref.current;
      if (!paint_style) {
        const computed_style = getComputedStyle(canvas);
        paint_style = {
          radius: parseFloat(
            computed_style.getPropertyValue("--timeline-block-radius"),
          ),
          border: parseFloat(
            computed_style.getPropertyValue("--timeline-block-border"),
          ),
          selection_width: parseFloat(
            computed_style.getPropertyValue("--timeline-block-selection-width"),
          ),
          label_padding: parseFloat(
            computed_style.getPropertyValue("--timeline-block-label-padding"),
          ),
          border_colors: {
            marker: timeline_color(
              computed_style,
              "--timeline-color-marker-border",
            ),
            candidate: timeline_color(
              computed_style,
              "--timeline-color-marker",
            ),
            transcript: timeline_color(
              computed_style,
              "--timeline-color-transcript-border",
            ),
            event: timeline_color(
              computed_style,
              "--timeline-color-event-border",
            ),
            event_analysis: timeline_color(
              computed_style,
              "--timeline-color-event-analysis-border",
            ),
          },
          font: computed_style.font,
          count_font: computed_style
            .getPropertyValue("--timeline-count-font")
            .trim(),
          label_color: timeline_color(
            computed_style,
            "--timeline-color-aggregate-label",
          ),
          block_colors: {
            marker: timeline_color(
              computed_style,
              "--timeline-color-marker-background",
            ),
            candidate: timeline_color(
              computed_style,
              "--timeline-color-candidate-background",
            ),
            transcript: timeline_color(
              computed_style,
              "--timeline-color-transcript-background",
            ),
            event: timeline_color(
              computed_style,
              "--timeline-color-event-background",
            ),
            event_analysis: timeline_color(
              computed_style,
              "--timeline-color-event-analysis-background",
            ),
          },
          selection_color: timeline_color(
            computed_style,
            "--timeline-color-selection-border",
          ),
        };
        paint_style_ref.current = paint_style;
      }
      if (!paint_style) return;

      context.setTransform(device_pixel_ratio, 0, 0, device_pixel_ratio, 0, 0);
      context.clearRect(0, 0, canvas_width, canvas_height);
      context.font = paint_style.font;
      context.textAlign = "center";
      context.textBaseline = "middle";
      for (const block of blocks) {
        context.font = paint_style.font;
        context.fillStyle = paint_style.block_colors[block.group.kind];
        const line_width = block.group.selected
          ? paint_style.selection_width
          : paint_style.border;
        const inset = line_width / 2;
        context.beginPath();
        context.roundRect(
          block.left + inset,
          block.top + inset,
          Math.max(0, block.width - line_width),
          Math.max(0, block.height - line_width),
          paint_style.radius,
        );
        context.fill();
        context.lineWidth = line_width;
        context.strokeStyle = block.group.selected
          ? paint_style.selection_color
          : paint_style.border_colors[block.group.kind];
        context.setLineDash(
          block.group.kind === "candidate"
            ? [paint_style.radius, paint_style.radius]
            : [],
        );
        context.stroke();
        const full_label = `${block.group.count} 个片段`;
        const label =
          context.measureText(full_label).width +
            paint_style.label_padding * 2 <=
          block.width
            ? full_label
            : String(block.group.count);
        if (label !== full_label) context.font = paint_style.count_font;
        if (
          context.measureText(label).width + paint_style.label_padding * 2 <=
          block.width
        ) {
          context.fillStyle = paint_style.label_color;
          context.fillText(
            label,
            block.left + block.width / 2,
            block.top + block.height / 2,
          );
        }
      }
    }, [blocks, canvas_width, canvas_height]);

    return (
      <div className="media_timeline_aggregate_layer">
        <canvas
          ref={canvas_ref}
          className="media_timeline_aggregate_canvas"
          aria-hidden="true"
        />
        {blocks.map(({ group, left, top, width, height }) => (
          <button
            type="button"
            key={`${group.row_id}:${group.members[0].id}`}
            className="media_timeline_aggregate_hit"
            data-action-id={group.members[0].id}
            style={{ left, top, width, height }}
            aria-label={`聚合 ${group.count} 个片段，${format_time(group.start_seconds)} 至 ${format_time(group.end_seconds)}`}
            aria-description="单击或空格选择，双击或 Enter 放大；Ctrl 或 Command 切换选择"
            aria-pressed={group.selected}
            title={`${group.count} 个片段；单击选择，双击放大`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              if (event.detail < 2)
                on_select(group.members, event.ctrlKey || event.metaKey);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              on_zoom(group);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              if (event.repeat) return;
              if (event.key === "Enter") on_zoom(group);
              else on_select(group.members, event.ctrlKey || event.metaKey);
            }}
          >
            <span className="sr_only">{group.count}</span>
          </button>
        ))}
      </div>
    );
  },
);

function timeline_color(style: CSSStyleDeclaration, property: string): string {
  return style.getPropertyValue(property).trim();
}
