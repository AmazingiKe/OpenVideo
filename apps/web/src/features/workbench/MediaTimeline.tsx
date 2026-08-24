import {
  CanvasRenderer,
  type Clip,
  type ClipHitTestResult,
  type Marker,
  Timeline,
  TimelineEngine,
  TimelineProvider,
  type Track,
  fromSeconds,
  toSeconds,
  useTimeline,
} from "@techsquidtv/canvas-timeline";
import "@techsquidtv/canvas-timeline/styles.css";
import {
  Captions,
  Flag,
  LockKeyhole,
  ScanSearch,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type WheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
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
import { Spinner } from "@/components/ui/spinner";
import { MarkerRangeField } from "@/features/workbench/MarkerRangeField";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { format_time } from "@/shared/format";
import { effective_marker_ranges } from "@/shared/marker_ranges";
import type {
  AnalysisStrategy,
  MediaMarker,
  MediaMarkerInput,
  MediaSegment,
  Transcript,
} from "@/shared/types";

const MINIMUM_DURATION_SECONDS = 1;
const MINIMUM_CLIP_DURATION_SECONDS = 0.05;
const DEFAULT_ZOOM_SCALE = 74;
const ALT_WHEEL_ZOOM_SENSITIVITY = -0.001;
const TRACK_HEIGHT = 48;
const DEFAULT_TRACK_COLUMN_WIDTH = "152px";
const MINIMUM_TRACK_COLUMN_WIDTH = "112px";
const MAXIMUM_TRACK_COLUMN_WIDTH = "320px";
const MINIMUM_TIMELINE_CANVAS_WIDTH = "240px";
const MARKER_EDITOR_OFFSET = 8;
const MARKER_EDITOR_COLLISION_PADDING = 8;
const MARKER_TRACK_ID = "timeline-marker-track";
const TRANSCRIPT_TRACK_ID = "timeline-transcript-track";
const EVENT_TRACK_ID = "timeline-event-track";
const TIMELINE_RULER_HEIGHT = 32;
const RANGE_DRAG_MINIMUM_PIXELS = 4;
const EMPTY_MARKERS: MediaMarker[] = [];

type TimelineTrackPresentation = {
  code: string;
  icon: LucideIcon;
};

const TIMELINE_TRACK_PRESENTATIONS: Record<string, TimelineTrackPresentation> =
  {
    [MARKER_TRACK_ID]: { code: "M1", icon: Flag },
    [TRANSCRIPT_TRACK_ID]: { code: "T1", icon: Captions },
    [EVENT_TRACK_ID]: { code: "E1", icon: ScanSearch },
  };

type MediaTimelineProps = {
  duration_seconds: number | null;
  current_time: number;
  transcript: Transcript | null;
  segments: MediaSegment[];
  markers: MediaMarker[];
  candidate_markers?: MediaMarker[];
  analysis_strategy: AnalysisStrategy;
  marker_error: string | null;
  on_seek: (seconds: number) => void;
  on_selected_transcript_indices_change: (segment_indices: number[]) => void;
  on_add_marker: (
    start_seconds: number,
    end_seconds?: number | null,
  ) => Promise<void>;
  on_update_marker: (
    marker_id: string,
    update: MediaMarkerInput,
  ) => Promise<void>;
  on_delete_marker: (marker_id: string) => Promise<void>;
  on_update_transcript: (segment_index: number, text: string) => Promise<void>;
};

type TimelineClipMetadata = {
  kind: "marker" | "candidate" | "transcript" | "event";
  source_id?: string;
  source_index?: number;
};

type TimelinePointerPosition = {
  x: number;
  y: number;
};

function TimelineLayers({
  on_clip_double_click,
}: {
  on_clip_double_click: (hit: ClipHitTestResult) => void;
}) {
  const { state } = useTimeline();

  return (
    <>
      <Timeline.PlayheadArea />
      <Timeline.PlayheadGrabber />
      <Timeline.TrackList className="timeline-track-list-overlay">
        {state.tracks.map((track) => (
          <Timeline.Track key={track.id} trackId={track.id} />
        ))}
      </Timeline.TrackList>
      <Timeline.ClipInteractionLayer
        onClipDoubleClick={(hit: ClipHitTestResult) =>
          on_clip_double_click(hit)
        }
      />
      <Timeline.RangeSelector />
    </>
  );
}

type TimelineSurfaceProps = {
  current_time: number;
  duration: number;
  engine: TimelineEngine;
  markers: MediaMarker[];
  analysis_strategy: AnalysisStrategy;
  selected_marker_id: string | null;
  on_seek: (seconds: number) => void;
  on_add_marker: (
    start_seconds: number,
    end_seconds?: number | null,
  ) => Promise<void>;
  on_update_marker_bounds: (
    marker_id: string,
    start_seconds: number,
    end_seconds: number | null,
  ) => void;
  on_select_marker: (
    marker_id: string,
    pointer_position: TimelinePointerPosition,
  ) => void;
  on_select_transcript: (segment_index: number) => void;
  on_edit_transcript: (segment_index: number) => void;
};

function TimelineSurface({
  current_time,
  duration,
  engine,
  markers,
  analysis_strategy,
  selected_marker_id,
  on_seek,
  on_add_marker,
  on_update_marker_bounds,
  on_select_marker,
  on_select_transcript,
  on_edit_transcript,
}: TimelineSurfaceProps) {
  const { state } = useTimeline();
  const syncing_playhead_ref = useRef(false);
  const pointer_position_ref = useRef<TimelinePointerPosition>({ x: 0, y: 0 });
  const range_drag_ref = useRef<{ x: number; start_seconds: number } | null>(
    null,
  );
  const resized_clip_ref = useRef<Clip | null>(null);

  useEffect(() => {
    const bounded_time = Math.min(Math.max(current_time, 0), duration);
    if (Math.abs(toSeconds(engine.getTime()) - bounded_time) < 0.01) return;
    syncing_playhead_ref.current = true;
    engine.setTime(fromSeconds(bounded_time));
    syncing_playhead_ref.current = false;
  }, [current_time, duration, engine]);

  useEffect(
    () =>
      engine.on("playhead:scrub", (time) => {
        if (!syncing_playhead_ref.current) on_seek(toSeconds(time));
      }),
    [engine, on_seek],
  );

  useEffect(
    () =>
      engine.on("clip:select", ({ clip }) => {
        if (!clip) return;
        const metadata = clip.metadata as TimelineClipMetadata | undefined;
        on_seek(toSeconds(clip.timelineStart));
        if (metadata?.kind === "marker" && metadata.source_id) {
          on_select_marker(metadata.source_id, pointer_position_ref.current);
          return;
        }
        if (
          metadata?.kind === "transcript" &&
          metadata.source_index !== undefined
        ) {
          on_select_transcript(metadata.source_index);
        }
      }),
    [engine, on_seek, on_select_marker, on_select_transcript],
  );

  useEffect(() => {
    const commit_bounds = (clip: Clip) => {
      const metadata = clip.metadata as TimelineClipMetadata | undefined;
      if (metadata?.kind !== "marker" || !metadata.source_id) return;
      const start_seconds = toSeconds(clip.timelineStart);
      const rendered_end = toSeconds(clip.timelineEnd);
      const end_seconds =
        rendered_end - start_seconds <= MINIMUM_CLIP_DURATION_SECONDS
          ? null
          : rendered_end;
      on_update_marker_bounds(metadata.source_id, start_seconds, end_seconds);
    };
    const unsubscribe_move = engine.on("clip:move", ({ clip, phase }) => {
      if (phase === "commit") commit_bounds(clip);
    });
    const unsubscribe_resize = engine.on("clip:resize", ({ clip }) => {
      resized_clip_ref.current = clip;
    });
    const unsubscribe_settled = engine.on("state:settled", () => {
      if (!resized_clip_ref.current) return;
      commit_bounds(resized_clip_ref.current);
      resized_clip_ref.current = null;
    });
    return () => {
      unsubscribe_move();
      unsubscribe_resize();
      unsubscribe_settled();
    };
  }, [engine, on_update_marker_bounds]);

  function add_marker_at_pointer(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const time = engine.pixelToTime(event.clientX - bounds.left);
    void on_add_marker(toSeconds(time));
  }

  function zoom_with_alt(event: WheelEvent<HTMLDivElement>) {
    if (!event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const viewport_x = event.clientX - bounds.left;
    const anchor_time = engine.pixelToTime(viewport_x);
    const zoom_delta = event.deltaY * ALT_WHEEL_ZOOM_SENSITIVITY;
    const zoom_scale = Math.max(0.01, engine.zoomScale * (1 + zoom_delta));
    engine.setZoomScale(zoom_scale);
    const scroll_left = Math.max(
      0,
      toSeconds(anchor_time) * engine.zoomScale - viewport_x,
    );
    engine.setScrollLeft(scroll_left);
  }

  function remember_pointer_position(event: PointerEvent<HTMLDivElement>) {
    pointer_position_ref.current = {
      x: event.clientX,
      y: event.clientY,
    };
    const bounds = event.currentTarget.getBoundingClientRect();
    const local_y = event.clientY - bounds.top;
    if (
      event.button === 0 &&
      local_y >= TIMELINE_RULER_HEIGHT &&
      local_y <= TIMELINE_RULER_HEIGHT + TRACK_HEIGHT
    ) {
      range_drag_ref.current = {
        x: event.clientX,
        start_seconds: bounded_pointer_time(
          event.clientX,
          bounds,
          engine,
          duration,
        ),
      };
    }
  }

  function create_range_at_pointer(event: PointerEvent<HTMLDivElement>) {
    const drag = range_drag_ref.current;
    range_drag_ref.current = null;
    if (!drag || Math.abs(event.clientX - drag.x) < RANGE_DRAG_MINIMUM_PIXELS) {
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const finish = bounded_pointer_time(
      event.clientX,
      bounds,
      engine,
      duration,
    );
    const start_seconds = Math.min(drag.start_seconds, finish);
    const end_seconds = Math.max(drag.start_seconds, finish);
    if (end_seconds - start_seconds >= MINIMUM_CLIP_DURATION_SECONDS) {
      void on_add_marker(start_seconds, end_seconds);
    }
  }

  function create_point_at_pointer(event: MouseEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const local_y = event.clientY - bounds.top;
    if (
      local_y < TIMELINE_RULER_HEIGHT ||
      local_y > TIMELINE_RULER_HEIGHT + TRACK_HEIGHT
    ) {
      return;
    }
    void on_add_marker(
      bounded_pointer_time(event.clientX, bounds, engine, duration),
    );
  }

  return (
    <ResizablePanelGroup
      id="timeline-track-layout"
      className="timeline-shell"
      orientation="horizontal"
    >
      <ResizablePanel
        id="timeline-track-column"
        className="timeline-track-panel"
        defaultSize={DEFAULT_TRACK_COLUMN_WIDTH}
        minSize={MINIMUM_TRACK_COLUMN_WIDTH}
        maxSize={MAXIMUM_TRACK_COLUMN_WIDTH}
        groupResizeBehavior="preserve-pixel-size"
      >
        <aside className="timeline-track-column" aria-label="时间线轨道">
          <span className="timeline-track-column-label">轨道</span>
          <Timeline.TrackHeaderList
            className="timeline-track-headers"
            aria-label="轨道列表"
          >
            {state.tracks.map((track) => {
              const presentation = TIMELINE_TRACK_PRESENTATIONS[track.id];
              if (!presentation) return null;
              const TrackIcon = presentation.icon;

              return (
                <Timeline.TrackHeader
                  key={track.id}
                  trackId={track.id}
                  className="timeline-track-header-row"
                  aria-label={`${presentation.code} ${track.name ?? "未命名轨道"}${track.locked ? "，只读" : ""}`}
                >
                  <span className="timeline-track-code">
                    {presentation.code}
                  </span>
                  <TrackIcon className="timeline-track-kind-icon" aria-hidden />
                  <span className="timeline-track-name">
                    {track.name ?? "未命名轨道"}
                  </span>
                  {track.locked ? (
                    <span className="timeline-track-lock" aria-label="只读">
                      <LockKeyhole aria-hidden />
                    </span>
                  ) : null}
                </Timeline.TrackHeader>
              );
            })}
          </Timeline.TrackHeaderList>
        </aside>
        <div className="timeline-scrollbar-spacer" aria-hidden />
      </ResizablePanel>
      <ResizableHandle
        className="hover:bg-primary"
        withHandle
        aria-label="调整轨道标题栏宽度"
      />
      <ResizablePanel
        id="timeline-canvas"
        className="timeline-canvas-panel"
        minSize={MINIMUM_TIMELINE_CANVAS_WIDTH}
      >
        <div className="timeline-canvas-stage">
          <Timeline.Root
            className="timeline-fill"
            aria-label="时间线画布；拖动平移，Alt 加滚轮缩放，方向键定位"
            onContextMenu={add_marker_at_pointer}
            onDoubleClick={create_point_at_pointer}
            onPointerDownCapture={remember_pointer_position}
            onPointerUpCapture={create_range_at_pointer}
            onWheelCapture={zoom_with_alt}
          >
            <CanvasRenderer />
            <MarkerRangeBands
              engine={engine}
              duration={duration}
              markers={markers}
              analysis_strategy={analysis_strategy}
              selected_marker_id={selected_marker_id}
            />
            <TimelineLayers
              on_clip_double_click={(hit) => {
                const metadata = hit.clip.metadata as
                  TimelineClipMetadata | undefined;
                if (
                  metadata?.kind === "transcript" &&
                  metadata.source_index !== undefined
                ) {
                  on_edit_transcript(metadata.source_index);
                }
              }}
            />
          </Timeline.Root>
        </div>
        <div className="timeline-scrollbar-control">
          <Timeline.ViewportScrollbar aria-label="时间线可见范围">
            <Timeline.ViewportScrollbarThumb>
              <Timeline.ViewportScrollbarHandle side="start" />
              <Timeline.ViewportScrollbarHandle side="end" />
            </Timeline.ViewportScrollbarThumb>
          </Timeline.ViewportScrollbar>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function MarkerRangeBands({
  engine,
  duration,
  markers,
  analysis_strategy,
  selected_marker_id,
}: {
  engine: TimelineEngine;
  duration: number;
  markers: MediaMarker[];
  analysis_strategy: AnalysisStrategy;
  selected_marker_id: string | null;
}) {
  const [, set_render_revision] = useState(0);

  useEffect(() => {
    const rerender = () => set_render_revision((revision) => revision + 1);
    const unsubscribe_scroll = engine.on("scroll:change", rerender);
    const unsubscribe_zoom = engine.on("zoom:change", rerender);
    const unsubscribe_resize = engine.on("viewport:resize", rerender);
    return () => {
      unsubscribe_scroll();
      unsubscribe_zoom();
      unsubscribe_resize();
    };
  }, [engine]);

  return (
    <div className="timeline-marker-ranges" aria-label="标记范围权重">
      {markers.map((marker) => {
        const { before_seconds, after_seconds } = effective_marker_ranges(
          marker,
          analysis_strategy,
        );
        const focus_end = marker.end_seconds ?? marker.start_seconds;
        const range_start = Math.max(0, marker.start_seconds - before_seconds);
        const range_end = Math.min(duration, focus_end + after_seconds);
        if (range_end <= range_start) return null;
        const left = engine.timeToPixel(fromSeconds(range_start));
        const right = engine.timeToPixel(fromSeconds(range_end));
        const width = right - left;
        if (width <= 0) return null;
        const core_start_position =
          ((marker.start_seconds - range_start) / (range_end - range_start)) *
          100;
        const core_end_position =
          ((focus_end - range_start) / (range_end - range_start)) * 100;
        const style = {
          left,
          width,
          "--marker-core-start-position": `${core_start_position}%`,
          "--marker-core-end-position": `${core_end_position}%`,
        } as CSSProperties;
        const marker_name =
          marker.title || marker.tags.join("、") || "未命名标记";

        return (
          <span
            key={marker.marker_id}
            className="timeline-marker-range"
            data-selected={
              marker.marker_id === selected_marker_id ? "true" : undefined
            }
            style={style}
            role="img"
            aria-label={`${marker_name}：向前 ${before_seconds} 秒，向后 ${after_seconds} 秒`}
          />
        );
      })}
    </div>
  );
}

export function MediaTimeline({
  duration_seconds,
  current_time,
  transcript,
  segments,
  markers,
  candidate_markers = EMPTY_MARKERS,
  analysis_strategy,
  marker_error,
  on_seek,
  on_selected_transcript_indices_change,
  on_add_marker,
  on_update_marker,
  on_delete_marker,
  on_update_transcript,
}: MediaTimelineProps) {
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
  const [marker_title_draft, set_marker_title_draft] = useState("");
  const [marker_tags_draft, set_marker_tags_draft] = useState("");
  const [marker_start_draft, set_marker_start_draft] = useState(0);
  const [marker_end_draft, set_marker_end_draft] = useState<number | null>(
    null,
  );
  const [marker_range_before_draft, set_marker_range_before_draft] = useState<
    number | null
  >(null);
  const [marker_range_after_draft, set_marker_range_after_draft] = useState<
    number | null
  >(null);
  const [confirming_delete, set_confirming_delete] = useState(false);
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
  const tracks = useMemo(
    () =>
      build_tracks(transcript_segments, segments, markers, candidate_markers),
    [candidate_markers, markers, segments, transcript_segments],
  );
  const timeline_markers = useMemo(() => build_markers(markers), [markers]);
  const engine = useMemo(
    () =>
      new TimelineEngine({
        duration: fromSeconds(duration),
        playheadTime: fromSeconds(0),
        zoomScale: DEFAULT_ZOOM_SCALE,
        tracks,
        markers: timeline_markers,
      }),
    [duration, timeline_markers, tracks],
  );
  const bounded_time = Math.min(Math.max(current_time, 0), duration);

  useEffect(() => {
    function add_marker_with_shortcut(event: globalThis.KeyboardEvent) {
      if (
        event.repeat ||
        !event.ctrlKey ||
        event.key.toLowerCase() !== "m" ||
        is_text_editing_target(event.target)
      ) {
        return;
      }
      event.preventDefault();
      void on_add_marker(bounded_time);
    }

    window.addEventListener("keydown", add_marker_with_shortcut);
    return () =>
      window.removeEventListener("keydown", add_marker_with_shortcut);
  }, [bounded_time, on_add_marker]);

  return (
    <section className="media_timeline" aria-label="剪辑时间轴">
      <header className="media_timeline_header">
        <output aria-label="当前播放时间">
          {format_time(bounded_time)} / {format_time(duration)}
        </output>
        <div>
          <strong>Canvas Timeline</strong>
          <span>
            {transcript_segments.length} 条转写 · {segments.length} 个事件 ·{" "}
            {markers.length} 个标记
          </span>
        </div>
      </header>

      {editing_transcript_index !== null ? (
        <form
          className="media_timeline_editor"
          onSubmit={(event) => void save_transcript(event)}
        >
          <Input
            autoFocus
            aria-label="编辑转写文字"
            value={transcript_draft}
            maxLength={10_000}
            onChange={(event) =>
              set_transcript_draft(event.currentTarget.value)
            }
            disabled={is_saving_transcript}
          />
          <Button
            type="submit"
            size="xs"
            disabled={is_saving_transcript || !transcript_draft.trim()}
          >
            {is_saving_transcript ? "保存中" : "保存"}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="secondary"
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
              className="timeline-marker-editor-anchor pointer-events-none fixed size-px"
              style={{
                left: marker_editor_position.x,
                top: marker_editor_position.y,
              }}
              aria-hidden
            />
          </PopoverAnchor>
        ) : null}
        <PopoverContent
          className="max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto"
          side="bottom"
          align="start"
          sideOffset={MARKER_EDITOR_OFFSET}
          collisionPadding={MARKER_EDITOR_COLLISION_PADDING}
        >
          <PopoverHeader>
            <PopoverTitle>编辑标记</PopoverTitle>
            <PopoverDescription>
              可精确编辑标题、标签和点/范围边界。
            </PopoverDescription>
          </PopoverHeader>
          <form className="flex flex-col gap-4" onSubmit={save_marker}>
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="marker-title">标题</FieldLabel>
                <Input
                  id="marker-title"
                  autoFocus
                  value={marker_title_draft}
                  maxLength={200}
                  placeholder="标记标题"
                  onChange={(event) =>
                    set_marker_title_draft(event.currentTarget.value)
                  }
                  disabled={is_saving_marker}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="marker-tags">标签</FieldLabel>
                <Input
                  id="marker-tags"
                  aria-label="编辑标记标签"
                  value={marker_tags_draft}
                  placeholder="输入标签，用逗号分隔"
                  onChange={(event) =>
                    set_marker_tags_draft(event.currentTarget.value)
                  }
                  disabled={is_saving_marker}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="marker-start">开始时间（秒）</FieldLabel>
                <Input
                  id="marker-start"
                  type="number"
                  min={0}
                  max={duration}
                  step={0.1}
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
                    step={0.1}
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
              <div className="rounded-md border bg-muted/30 p-4">
                <p className="mb-4 text-sm font-medium">标记范围权重</p>
                <div className="flex flex-col gap-4">
                  <MarkerRangeField
                    id="marker-range-before"
                    label="向前范围"
                    value={marker_range_before_draft}
                    default_value={
                      analysis_strategy.marker_range_before_seconds
                    }
                    disabled={is_saving_marker}
                    on_change={set_marker_range_before_draft}
                  />
                  <MarkerRangeField
                    id="marker-range-after"
                    label="向后范围"
                    value={marker_range_after_draft}
                    default_value={analysis_strategy.marker_range_after_seconds}
                    disabled={is_saving_marker}
                    on_change={set_marker_range_after_draft}
                  />
                </div>
              </div>
            </FieldGroup>
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                set_marker_end_draft((current) =>
                  current === null
                    ? Math.min(duration, marker_start_draft + 5)
                    : null,
                )
              }
              disabled={is_saving_marker}
            >
              转换为{marker_end_draft === null ? "范围" : "点"}标记
            </Button>
            {marker_save_error ? (
              <FieldDescription className="text-destructive" role="alert">
                {marker_save_error}
              </FieldDescription>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  if (!confirming_delete) {
                    set_confirming_delete(true);
                    return;
                  }
                  if (editing_marker_id === null) return;
                  set_is_saving_marker(true);
                  void on_delete_marker(editing_marker_id).then(
                    cancel_marker_edit,
                  );
                }}
                disabled={is_saving_marker}
              >
                <Trash2 data-icon="inline-start" />
                {confirming_delete ? "确认删除" : "删除"}
              </Button>
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
                {is_saving_marker ? <Spinner data-icon="inline-start" /> : null}
                {is_saving_marker ? "保存中…" : "保存"}
              </Button>
            </div>
          </form>
        </PopoverContent>
      </Popover>

      <div
        className="media_timeline_canvas"
        tabIndex={0}
        onKeyDown={scrub_with_keyboard}
      >
        <TimelineProvider engine={engine}>
          <TimelineSurface
            current_time={current_time}
            duration={duration}
            engine={engine}
            markers={markers}
            analysis_strategy={analysis_strategy}
            selected_marker_id={editing_marker_id}
            on_seek={on_seek}
            on_add_marker={on_add_marker}
            on_update_marker_bounds={(
              marker_id,
              start_seconds,
              end_seconds,
            ) => {
              const marker = markers.find(
                (item) => item.marker_id === marker_id,
              );
              if (!marker) return;
              void on_update_marker(marker_id, {
                start_seconds,
                end_seconds,
                title: marker.title,
                tags: marker.tags,
                marker_range_before_seconds: marker.marker_range_before_seconds,
                marker_range_after_seconds: marker.marker_range_after_seconds,
              });
            }}
            on_select_marker={select_marker}
            on_select_transcript={(segment_index) =>
              on_selected_transcript_indices_change([segment_index])
            }
            on_edit_transcript={(segment_index) => {
              on_selected_transcript_indices_change([segment_index]);
              edit_transcript(segment_index);
            }}
          />
        </TimelineProvider>
      </div>

      {transcript_error ? (
        <p className="media_timeline_error" role="alert">
          {transcript_error}
        </p>
      ) : null}
      {marker_error ? (
        <p className="media_timeline_error" role="alert">
          {marker_error}
        </p>
      ) : null}
    </section>
  );

  function select_marker(
    marker_id: string,
    pointer_position: TimelinePointerPosition,
  ) {
    const marker = markers.find(
      (candidate) => candidate.marker_id === marker_id,
    );
    if (!marker) return;
    set_editing_marker_id(marker.marker_id);
    set_marker_title_draft(marker.title);
    set_marker_tags_draft(marker.tags.join(", "));
    set_marker_start_draft(marker.start_seconds);
    set_marker_end_draft(marker.end_seconds);
    set_marker_range_before_draft(marker.marker_range_before_seconds);
    set_marker_range_after_draft(marker.marker_range_after_seconds);
    set_confirming_delete(false);
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
    const tags = marker_tags_draft
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    set_is_saving_marker(true);
    set_marker_save_error(null);
    void on_update_marker(editing_marker_id, {
      start_seconds: marker_start_draft,
      end_seconds: marker_end_draft,
      title: marker_title_draft,
      tags,
      marker_range_before_seconds: marker_range_before_draft,
      marker_range_after_seconds: marker_range_after_draft,
    })
      .then(cancel_marker_edit)
      .catch(() => set_marker_save_error("标记保存失败，请稍后重试"))
      .finally(() => set_is_saving_marker(false));
  }

  function cancel_marker_edit() {
    set_editing_marker_id(null);
    set_marker_title_draft("");
    set_marker_tags_draft("");
    set_marker_start_draft(0);
    set_marker_end_draft(null);
    set_marker_range_before_draft(null);
    set_marker_range_after_draft(null);
    set_confirming_delete(false);
    set_marker_save_error(null);
    set_marker_editor_position(null);
  }

  function scrub_with_keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    on_seek(Math.min(Math.max(bounded_time + direction, 0), duration));
  }
}

function build_tracks(
  transcript_segments: Transcript["segments"],
  segments: MediaSegment[],
  markers: MediaMarker[],
  candidate_markers: MediaMarker[],
): Track[] {
  return [
    create_track(
      MARKER_TRACK_ID,
      "标记",
      "marker",
      [
        ...markers.map((marker) =>
          create_clip(
            marker.marker_id,
            marker.marker_id,
            marker.start_seconds,
            marker.end_seconds ??
              marker.start_seconds + MINIMUM_CLIP_DURATION_SECONDS,
            marker.title || marker.tags.join(" · ") || "未命名标记",
            { kind: "marker", source_id: marker.marker_id },
          ),
        ),
        ...candidate_markers.map((marker) =>
          create_clip(
            `candidate-${marker.marker_id}`,
            marker.marker_id,
            marker.start_seconds,
            marker.end_seconds ??
              marker.start_seconds + MINIMUM_CLIP_DURATION_SECONDS,
            `待审批 · ${marker.title || "标记"}`,
            { kind: "candidate", source_id: marker.marker_id },
          ),
        ),
      ],
      false,
    ),
    create_track(
      TRANSCRIPT_TRACK_ID,
      "转写",
      "subtitle",
      transcript_segments.map((segment, index) =>
        create_clip(
          `transcript-${index}`,
          `transcript-${index}`,
          segment.start_seconds,
          segment.end_seconds,
          segment.text,
          { kind: "transcript", source_index: index },
        ),
      ),
    ),
    create_track(
      EVENT_TRACK_ID,
      "分析事件",
      "event",
      segments.map((segment) =>
        create_clip(
          segment.segment_id,
          segment.asset_id,
          segment.start_seconds,
          segment.end_seconds,
          segment.title,
          { kind: "event", source_id: segment.segment_id },
        ),
      ),
    ),
  ];
}

function create_track(
  id: string,
  name: string,
  kind: string,
  clips: Clip[],
  locked = true,
): Track {
  return {
    id,
    name,
    kind,
    clips,
    selected: false,
    locked,
    muted: false,
    visible: true,
    height: TRACK_HEIGHT,
  };
}

function create_clip(
  id: string,
  source_id: string,
  start_seconds: number,
  end_seconds: number,
  label: string,
  metadata: TimelineClipMetadata,
): Clip {
  const timeline_end = Math.max(
    end_seconds,
    start_seconds + MINIMUM_CLIP_DURATION_SECONDS,
  );
  return {
    id,
    sourceId: source_id,
    timelineStart: fromSeconds(start_seconds),
    timelineEnd: fromSeconds(timeline_end),
    sourceStart: fromSeconds(0),
    selected: false,
    label,
    movable: metadata.kind === "marker",
    resizable: metadata.kind === "marker",
    metadata,
  };
}

function build_markers(markers: MediaMarker[]): Marker[] {
  return markers.map((marker) => ({
    id: marker.marker_id,
    time: fromSeconds(marker.start_seconds),
    label: marker.title || marker.tags.join(" · ") || "标记",
  }));
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

function bounded_pointer_time(
  client_x: number,
  bounds: DOMRect,
  engine: TimelineEngine,
  duration: number,
): number {
  const seconds = toSeconds(engine.pixelToTime(client_x - bounds.left));
  return Math.min(Math.max(seconds, 0), duration);
}

function is_text_editing_target(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("input, textarea, [contenteditable='true']") !== null
  );
}
