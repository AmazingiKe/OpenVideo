import { Minus, Plus, RotateCcw } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { format_timeline_time } from "./timeline_time";
import {
  DEFAULT_TIMELINE_MERGE_THRESHOLD,
  MAXIMUM_TIMELINE_MERGE_THRESHOLD,
  DEFAULT_ZOOM_PIXELS_PER_SECOND,
  MAXIMUM_ZOOM_PIXELS_PER_SECOND,
} from "./media_timeline_calculations";

const ZOOM_BUTTON_FACTOR = 1.25;
const ZOOM_SLIDER_STEPS = 1_000;

type MediaTimelineToolbarProps = {
  current_time: number;
  current_time_output_ref: RefObject<HTMLOutputElement | null>;
  duration: number;
  minimum_zoom_pixels_per_second: number;
  zoom_pixels_per_second: number;
  on_zoom_change: (zoom_pixels_per_second: number) => void;
  merge_threshold: number;
  on_merge_threshold_change: (threshold: number) => void;
  context_sources?: ReactNode;
};

export function MediaTimelineToolbar({
  current_time,
  current_time_output_ref,
  duration,
  minimum_zoom_pixels_per_second,
  zoom_pixels_per_second,
  on_zoom_change,
  context_sources,
  merge_threshold,
  on_merge_threshold_change,
}: MediaTimelineToolbarProps) {
  const threshold_frame_ref = useRef<number | null>(null);
  const pending_threshold_ref = useRef(merge_threshold);
  const threshold_callback_ref = useRef(on_merge_threshold_change);
  const scheduled_zoom_ref = useRef<number | null>(null);
  const zoom_frame_ref = useRef<number | null>(null);
  const on_zoom_change_ref = useRef(on_zoom_change);
  const [preview_zoom, set_preview_zoom] = useState(zoom_pixels_per_second);
  const zoom_logarithmic_range = Math.log(
    MAXIMUM_ZOOM_PIXELS_PER_SECOND / minimum_zoom_pixels_per_second,
  );
  const slider_position =
    (Math.log(preview_zoom / minimum_zoom_pixels_per_second) /
      zoom_logarithmic_range) *
    ZOOM_SLIDER_STEPS;

  useLayoutEffect(() => {
    set_preview_zoom(zoom_pixels_per_second);
  }, [zoom_pixels_per_second]);

  useLayoutEffect(() => {
    on_zoom_change_ref.current = on_zoom_change;
    threshold_callback_ref.current = on_merge_threshold_change;
  });

  useEffect(
    () => () => {
      if (threshold_frame_ref.current !== null)
        window.cancelAnimationFrame(threshold_frame_ref.current);
      if (zoom_frame_ref.current !== null) {
        window.cancelAnimationFrame(zoom_frame_ref.current);
      }
    },
    [],
  );

  function schedule_threshold(threshold: number) {
    pending_threshold_ref.current = threshold;
    if (threshold_frame_ref.current !== null) return;
    threshold_frame_ref.current = window.requestAnimationFrame(() => {
      threshold_frame_ref.current = null;
      threshold_callback_ref.current(pending_threshold_ref.current);
    });
  }

  function apply_scheduled_zoom() {
    zoom_frame_ref.current = null;
    const scheduled_zoom = scheduled_zoom_ref.current;
    scheduled_zoom_ref.current = null;
    if (scheduled_zoom !== null) {
      flushSync(() => on_zoom_change_ref.current(scheduled_zoom));
    }
  }

  function schedule_zoom(zoom: number) {
    set_preview_zoom(zoom);
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
        <output
          ref={current_time_output_ref}
          className="media_timeline_current_time"
          aria-label="当前播放时间"
        >
          {format_timeline_time(current_time)}
        </output>
        <span aria-hidden="true">/</span>
        <output aria-label="总时长">
          {format_timeline_time(duration, { milliseconds: false })}
        </output>
        {context_sources}
      </div>
      <div className="media_timeline_merge_threshold">
        <span>合并阈值</span>
        <Slider
          value={[merge_threshold]}
          min={0}
          max={MAXIMUM_TIMELINE_MERGE_THRESHOLD}
          step={1}
          onValueChange={([threshold = DEFAULT_TIMELINE_MERGE_THRESHOLD]) =>
            schedule_threshold(threshold)
          }
          aria-label="合并阈值"
          aria-valuetext={
            merge_threshold === 0 ? "关闭" : `${merge_threshold} px`
          }
        />
        <output aria-label="当前合并阈值" aria-live="polite">
          {merge_threshold === 0 ? "关闭" : `${merge_threshold} px`}
        </output>
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
          value={[slider_position]}
          min={0}
          max={ZOOM_SLIDER_STEPS}
          step={1}
          onValueChange={([position = 0]) =>
            schedule_zoom(
              position === ZOOM_SLIDER_STEPS
                ? MAXIMUM_ZOOM_PIXELS_PER_SECOND
                : minimum_zoom_pixels_per_second *
                    Math.exp(
                      (position / ZOOM_SLIDER_STEPS) * zoom_logarithmic_range,
                    ),
            )
          }
          aria-label="时间线缩放比例"
          aria-valuetext={`${format_timeline_zoom(preview_zoom)} px/s`}
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
