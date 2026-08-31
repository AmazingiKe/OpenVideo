import {
  Eraser,
  Flag,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
} from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { format_time } from "@/shared/format";
import {
  DEFAULT_ZOOM_PIXELS_PER_SECOND,
  MAXIMUM_ZOOM_PIXELS_PER_SECOND,
} from "./media_timeline_calculations";

const ZOOM_BUTTON_FACTOR = 1.25;
const ZOOM_SLIDER_STEP = 0.1;
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

type MediaTimelineToolbarProps = {
  current_time: number;
  current_time_output_ref: RefObject<HTMLOutputElement | null>;
  duration: number;
  is_paused: boolean;
  playback_rate: number;
  minimum_zoom_pixels_per_second: number;
  zoom_pixels_per_second: number;
  on_toggle_playback: () => void;
  on_playback_rate_change: (rate: number) => void;
  on_add_marker: (seconds: number) => void;
  on_set_range_start: () => void;
  on_set_range_end: () => void;
  on_clear_range: () => void;
  has_range_selection: boolean;
  on_zoom_change: (zoom_pixels_per_second: number) => void;
  tools: ReactNode;
  context_sources?: ReactNode;
};

export function MediaTimelineToolbar({
  current_time,
  current_time_output_ref,
  duration,
  is_paused,
  playback_rate,
  minimum_zoom_pixels_per_second,
  zoom_pixels_per_second,
  on_toggle_playback,
  on_playback_rate_change,
  on_add_marker,
  on_set_range_start,
  on_set_range_end,
  on_clear_range,
  has_range_selection,
  on_zoom_change,
  tools,
  context_sources,
}: MediaTimelineToolbarProps) {
  const bounded_time = current_time;
  const scheduled_zoom_ref = useRef<number | null>(null);
  const zoom_frame_ref = useRef<number | null>(null);
  const on_zoom_change_ref = useRef(on_zoom_change);

  useLayoutEffect(() => {
    on_zoom_change_ref.current = on_zoom_change;
  });

  useEffect(
    () => () => {
      if (zoom_frame_ref.current !== null) {
        window.cancelAnimationFrame(zoom_frame_ref.current);
      }
    },
    [],
  );

  function apply_scheduled_zoom() {
    zoom_frame_ref.current = null;
    const scheduled_zoom = scheduled_zoom_ref.current;
    scheduled_zoom_ref.current = null;
    if (scheduled_zoom !== null) on_zoom_change_ref.current(scheduled_zoom);
  }

  function schedule_zoom(zoom: number) {
    scheduled_zoom_ref.current = zoom;
    if (zoom_frame_ref.current !== null) return;
    zoom_frame_ref.current = window.requestAnimationFrame(apply_scheduled_zoom);
  }

  function apply_zoom_immediately(zoom: number) {
    if (zoom_frame_ref.current !== null) {
      window.cancelAnimationFrame(zoom_frame_ref.current);
      zoom_frame_ref.current = null;
    }
    scheduled_zoom_ref.current = null;
    on_zoom_change_ref.current(zoom);
  }

  return (
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
        <output ref={current_time_output_ref} aria-label="当前播放时间和总时长">
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
          onClick={() => on_add_marker(bounded_time)}
        >
          <Flag data-icon="inline-start" aria-hidden="true" />
          <span className="media_timeline_add_label">添加标记</span>
        </Button>
        {tools}
        {context_sources}
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          title="设置范围起点（[）；有片段选中时使用片段起点"
          aria-label="设置范围起点"
          onClick={on_set_range_start}
        >
          [
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          title="设置范围终点（]）；有片段选中时使用片段终点"
          aria-label="设置范围终点"
          onClick={on_set_range_end}
        >
          ]
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={!has_range_selection}
          onClick={on_clear_range}
          aria-label="清除时间线范围选区"
        >
          <Eraser aria-hidden="true" />
        </Button>
      </div>
      <div className="media_timeline_zoom" aria-label="时间线缩放">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={zoom_pixels_per_second <= minimum_zoom_pixels_per_second}
          onClick={() =>
            apply_zoom_immediately(zoom_pixels_per_second / ZOOM_BUTTON_FACTOR)
          }
          aria-label="缩小时间线"
        >
          <Minus data-icon="inline-start" aria-hidden="true" />
        </Button>
        <Slider
          value={[zoom_pixels_per_second]}
          min={minimum_zoom_pixels_per_second}
          max={MAXIMUM_ZOOM_PIXELS_PER_SECOND}
          step={ZOOM_SLIDER_STEP}
          onValueChange={([zoom = DEFAULT_ZOOM_PIXELS_PER_SECOND]) =>
            schedule_zoom(zoom)
          }
          aria-label="时间线缩放比例"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={zoom_pixels_per_second >= MAXIMUM_ZOOM_PIXELS_PER_SECOND}
          onClick={() =>
            apply_zoom_immediately(zoom_pixels_per_second * ZOOM_BUTTON_FACTOR)
          }
          aria-label="放大时间线"
        >
          <Plus data-icon="inline-start" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => apply_zoom_immediately(DEFAULT_ZOOM_PIXELS_PER_SECOND)}
          aria-label="重置时间线缩放"
          title="重置为 80 px/s"
        >
          <RotateCcw data-icon="inline-start" aria-hidden="true" />
        </Button>
        <output aria-label="当前时间线缩放">
          {format_timeline_zoom(zoom_pixels_per_second)} px/s
        </output>
      </div>
    </div>
  );
}

function format_timeline_zoom(zoom_pixels_per_second: number): string {
  return zoom_pixels_per_second < 1
    ? zoom_pixels_per_second.toFixed(2)
    : String(Math.round(zoom_pixels_per_second));
}
