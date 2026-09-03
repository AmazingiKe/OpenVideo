import { Minus, Plus, RotateCcw } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { format_time } from "@/shared/format";
import {
  DEFAULT_ZOOM_PIXELS_PER_SECOND,
  MAXIMUM_ZOOM_PIXELS_PER_SECOND,
} from "./media_timeline_calculations";

const ZOOM_BUTTON_FACTOR = 1.25;
const ZOOM_SLIDER_STEP = 0.1;

type MediaTimelineToolbarProps = {
  current_time: number;
  current_time_output_ref: RefObject<HTMLOutputElement | null>;
  duration: number;
  minimum_zoom_pixels_per_second: number;
  zoom_pixels_per_second: number;
  on_zoom_change: (zoom_pixels_per_second: number) => void;
  tools: ReactNode;
  context_sources?: ReactNode;
};

export function MediaTimelineToolbar({
  current_time,
  current_time_output_ref,
  duration,
  minimum_zoom_pixels_per_second,
  zoom_pixels_per_second,
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
        <output ref={current_time_output_ref} aria-label="当前播放时间和总时长">
          {format_time(bounded_time)} / {format_time(duration)}
        </output>
        {tools}
        {context_sources}
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
