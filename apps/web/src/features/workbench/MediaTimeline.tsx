import {
  CanvasRenderer,
  type Clip,
  type ClipHitTestResult,
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
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
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
import { Spinner } from "@/components/ui/spinner";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
const INVISIBLE_CLIP_OPACITY = 0;
const DEFAULT_MARKER_HIT_DURATION_SECONDS = 0.4;
const EMPTY_MARKERS: MediaMarker[] = [];
const MARKER_IMPORTANCE_VALUES: MarkerImportance[] = [0, 1, 2, 3, 4, 5];
const MARKER_SHAPE_VALUES = {
  point: "point",
  range: "range",
} as const;

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
  ) => Promise<MediaMarker | undefined>;
  on_update_marker: (
    marker_id: string,
    update: MediaMarkerUpdate,
  ) => Promise<void>;
  on_delete_marker: (marker_id: string) => Promise<void>;
  on_update_transcript: (segment_index: number, text: string) => Promise<void>;
};

type TimelineClipMetadata = {
  kind: "marker" | "candidate" | "transcript" | "event";
  source_id?: string;
  source_index?: number;
  marker_shape?: "default" | "manual";
  marker_anchor_seconds?: number;
  rendered_start_seconds?: number;
};

type TimelineMarkerGeometry = Pick<
  MediaMarker,
  "marker_id" | "start_seconds" | "end_seconds"
>;

type TimelinePointerPosition = {
  x: number;
  y: number;
};

type TimelineViewportState = {
  zoom_scale: number;
  scroll_left: number;
  scroll_top: number;
};

function TimelineLayers({
  on_clip_double_click,
  markers,
  selected_marker_id,
}: {
  on_clip_double_click: (hit: ClipHitTestResult) => void;
  markers: MediaMarker[];
  selected_marker_id: string | null;
}) {
  const { state } = useTimeline();
  const marker_labels = useMemo(
    () =>
      new Map(
        markers.map((marker) => [
          marker.marker_id,
          format_marker_label(marker),
        ]),
      ),
    [markers],
  );
  const get_clip_aria_label = useCallback(
    (clip: Clip, track: Track) =>
      timeline_clip_aria_label(clip, track, marker_labels),
    [marker_labels],
  );

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
        activeClipId={selected_marker_id ?? undefined}
        getClipAriaLabel={get_clip_aria_label}
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
  ) => Promise<MediaMarker | undefined>;
  on_update_marker_bounds: (
    marker_id: string,
    start_seconds: number,
    end_seconds: number | null,
  ) => void;
  on_select_marker: (
    marker_id: string | null,
    viewport: TimelineViewportState,
  ) => void;
  on_edit_marker: (
    marker_id: string,
    pointer_position: TimelinePointerPosition,
  ) => void;
  on_rate_marker: (marker_id: string, importance: MarkerImportance) => void;
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
  on_edit_marker,
  on_rate_marker,
  on_select_transcript,
  on_edit_transcript,
}: TimelineSurfaceProps) {
  const { state } = useTimeline();
  const syncing_playhead_ref = useRef(false);
  const pointer_position_ref = useRef<TimelinePointerPosition>({ x: 0, y: 0 });
  const resized_clip_ref = useRef<Clip | null>(null);
  const [context_marker_id, set_context_marker_id] = useState<string | null>(
    null,
  );
  const context_marker = markers.find(
    (marker) => marker.marker_id === (context_marker_id ?? selected_marker_id),
  );
  const viewport_start_seconds = state.scrollLeft / state.zoomScale;
  const viewport_end_seconds =
    viewport_start_seconds + (state.viewportWidth ?? 0) / state.zoomScale;
  const viewport_percent_denominator = Math.max(duration, Number.EPSILON);
  const viewport_start_percent = Math.min(
    100,
    Math.max(0, (viewport_start_seconds / viewport_percent_denominator) * 100),
  );
  const viewport_end_percent = Math.min(
    100,
    Math.max(0, (viewport_end_seconds / viewport_percent_denominator) * 100),
  );

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
        if (!clip) {
          on_select_marker(null, current_timeline_viewport(engine));
          return;
        }
        const metadata = clip.metadata as TimelineClipMetadata | undefined;
        if (metadata?.kind === "marker" && metadata.source_id) {
          on_seek(
            metadata.marker_anchor_seconds ?? toSeconds(clip.timelineStart),
          );
          on_select_marker(
            metadata.source_id,
            current_timeline_viewport(engine),
          );
          return;
        }
        on_select_marker(null, current_timeline_viewport(engine));
        on_seek(toSeconds(clip.timelineStart));
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
    const commit_bounds = (clip: Clip, interaction: "move" | "resize") => {
      const metadata = clip.metadata as TimelineClipMetadata | undefined;
      if (metadata?.kind !== "marker" || !metadata.source_id) return;
      const start_seconds = toSeconds(clip.timelineStart);
      const rendered_end = toSeconds(clip.timelineEnd);
      if (
        metadata.marker_shape === "default" &&
        interaction === "move" &&
        metadata.marker_anchor_seconds !== undefined &&
        metadata.rendered_start_seconds !== undefined
      ) {
        const movement = start_seconds - metadata.rendered_start_seconds;
        on_update_marker_bounds(
          metadata.source_id,
          metadata.marker_anchor_seconds + movement,
          null,
        );
        return;
      }
      const end_seconds =
        rendered_end - start_seconds <= MINIMUM_CLIP_DURATION_SECONDS
          ? null
          : rendered_end;
      on_update_marker_bounds(metadata.source_id, start_seconds, end_seconds);
    };
    const unsubscribe_move = engine.on("clip:move", ({ clip, phase }) => {
      if (phase === "commit") commit_bounds(clip, "move");
    });
    const unsubscribe_resize = engine.on("clip:resize", ({ clip }) => {
      resized_clip_ref.current = clip;
    });
    const unsubscribe_settled = engine.on("state:settled", () => {
      if (!resized_clip_ref.current) return;
      commit_bounds(resized_clip_ref.current, "resize");
      resized_clip_ref.current = null;
    });
    return () => {
      unsubscribe_move();
      unsubscribe_resize();
      unsubscribe_settled();
    };
  }, [engine, on_update_marker_bounds]);

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
    const local_x = event.clientX - bounds.left;
    if (
      engine.getClipAtPoint({
        x: local_x,
        y: local_y,
        pointerType: "mouse",
      })
    ) {
      return;
    }
    void on_add_marker(
      bounded_pointer_time(event.clientX, bounds, engine, duration),
    );
  }

  function prepare_marker_context_menu(event: MouseEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const uses_pointer_position = event.clientX !== 0 || event.clientY !== 0;
    const hit = uses_pointer_position
      ? engine.getClipAtPoint({
          x: event.clientX - bounds.left,
          y: event.clientY - bounds.top,
          pointerType: "mouse",
        })
      : null;
    const metadata = hit?.clip.metadata as TimelineClipMetadata | undefined;
    const marker_id = uses_pointer_position
      ? metadata?.kind === "marker"
        ? metadata.source_id
        : undefined
      : selected_marker_id;
    if (!marker_id) {
      event.preventDefault();
      return;
    }
    const marker = markers.find(
      (candidate) => candidate.marker_id === marker_id,
    );
    if (!marker) {
      event.preventDefault();
      return;
    }
    set_context_marker_id(marker_id);
    on_select_marker(marker_id, current_timeline_viewport(engine));
    on_seek(marker.start_seconds);
  }

  function open_marker_context_menu_with_keyboard(
    event: KeyboardEvent<HTMLDivElement>,
  ) {
    const is_menu_key = event.key === "ContextMenu";
    const is_shift_f10 = event.shiftKey && event.key === "F10";
    if ((!is_menu_key && !is_shift_f10) || !selected_marker_id) return;
    event.preventDefault();
    set_context_marker_id(selected_marker_id);
    event.currentTarget.dispatchEvent(
      new globalThis.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      }),
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
                    <span className="timeline-track-lock" aria-hidden>
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
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <Timeline.Root
                className="timeline-fill"
                tabIndex={0}
                aria-label="时间线画布；单击标记显示手柄，双击空白处添加，双击标记编辑"
                onDoubleClick={create_point_at_pointer}
                onKeyDownCapture={open_marker_context_menu_with_keyboard}
                onPointerDownCapture={remember_pointer_position}
                onContextMenuCapture={prepare_marker_context_menu}
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
                  markers={markers}
                  selected_marker_id={selected_marker_id}
                  on_clip_double_click={(hit) => {
                    const metadata = hit.clip.metadata as
                      TimelineClipMetadata | undefined;
                    if (metadata?.kind === "marker" && metadata.source_id) {
                      on_edit_marker(
                        metadata.source_id,
                        pointer_position_ref.current,
                      );
                      return;
                    }
                    if (
                      metadata?.kind === "transcript" &&
                      metadata.source_index !== undefined
                    ) {
                      on_edit_transcript(metadata.source_index);
                    }
                  }}
                />
              </Timeline.Root>
            </ContextMenuTrigger>
            {context_marker ? (
              <ContextMenuContent className="min-w-48">
                <ContextMenuGroup>
                  <ContextMenuLabel>标记重要程度</ContextMenuLabel>
                  <ContextMenuRadioGroup
                    value={String(context_marker.importance)}
                    onValueChange={(value) =>
                      on_rate_marker(
                        context_marker.marker_id,
                        Number(value) as MarkerImportance,
                      )
                    }
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
        <div className="timeline-scrollbar-control">
          <Timeline.ViewportScrollbar aria-label="时间线可见范围">
            <Timeline.ViewportScrollbarThumb />
            <Timeline.ViewportScrollbarHandle
              side="start"
              style={{ left: `${viewport_start_percent}%` }}
            />
            <Timeline.ViewportScrollbarHandle
              side="end"
              style={{
                left: `${viewport_end_percent}%`,
                right: "auto",
                transform: "translateX(-100%)",
              }}
            />
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
    <div className="timeline-marker-ranges" aria-label="标记影响范围">
      {markers.map((marker) => {
        const marker_shape = marker.end_seconds === null ? "default" : "manual";
        const before_seconds =
          marker_shape === "default"
            ? analysis_strategy.marker_range_before_seconds
            : 0;
        const after_seconds =
          marker_shape === "default"
            ? analysis_strategy.marker_range_after_seconds
            : 0;
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
        const label_position =
          marker_shape === "default"
            ? core_start_position
            : (core_start_position + core_end_position) / 2;
        const style = {
          left,
          width,
          "--marker-core-start-position": `${core_start_position}%`,
          "--marker-core-end-position": `${core_end_position}%`,
          "--marker-label-position": `${label_position}%`,
        } as CSSProperties;
        const marker_name = format_marker_label(marker);

        return (
          <span
            key={marker.marker_id}
            className="timeline-marker-range"
            data-selected={
              marker.marker_id === selected_marker_id ? "true" : undefined
            }
            data-shape={marker_shape}
            style={style}
            role="img"
            aria-label={
              marker_shape === "default"
                ? `${marker_name}：默认范围，向前 ${before_seconds} 秒，向后 ${after_seconds} 秒`
                : `${marker_name}：手动范围 ${format_time(marker.start_seconds)} 至 ${format_time(focus_end)}`
            }
          >
            <span className="timeline-marker-label" aria-hidden>
              {marker_name}
            </span>
          </span>
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
  const [marker_selection, set_marker_selection] = useState<{
    marker_id: string | null;
    viewport: TimelineViewportState;
  }>({
    marker_id: null,
    viewport: {
      zoom_scale: DEFAULT_ZOOM_SCALE,
      scroll_left: 0,
      scroll_top: 0,
    },
  });
  const selected_marker_id = marker_selection.marker_id;
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
  const [timeline_markers, set_timeline_markers] = useState(() =>
    create_timeline_marker_geometry(markers),
  );
  // 评分只改变展示信息；几何未变时保留引用，避免时间线引擎重建。
  useLayoutEffect(() => {
    set_timeline_markers((current) =>
      has_same_marker_geometry(current, markers)
        ? current
        : create_timeline_marker_geometry(markers),
    );
  }, [markers]);
  const duration = timeline_duration(
    duration_seconds,
    current_time,
    transcript_segments,
    segments,
    [...timeline_markers, ...candidate_markers],
  );
  const tracks = useMemo(
    () =>
      build_tracks(
        transcript_segments,
        segments,
        timeline_markers,
        candidate_markers,
        analysis_strategy,
        duration,
        selected_marker_id,
      ),
    [
      analysis_strategy,
      candidate_markers,
      duration,
      selected_marker_id,
      segments,
      timeline_markers,
      transcript_segments,
    ],
  );
  const engine = useMemo(
    () =>
      new TimelineEngine({
        duration: fromSeconds(duration),
        playheadTime: fromSeconds(0),
        zoomScale: marker_selection.viewport.zoom_scale,
        scrollLeft: marker_selection.viewport.scroll_left,
        scrollTop: marker_selection.viewport.scroll_top,
        tracks,
      }),
    [duration, marker_selection.viewport, tracks],
  );
  const bounded_time = Math.min(Math.max(current_time, 0), duration);
  const timeline_error = transcript_error ?? marker_error;
  const add_marker_and_select = useCallback(
    async (
      start_seconds: number,
      end_seconds: number | null = null,
    ): Promise<MediaMarker | undefined> => {
      try {
        const marker = await on_add_marker(start_seconds, end_seconds);
        if (marker) {
          set_marker_selection((current) => ({
            marker_id: marker.marker_id,
            viewport: current.viewport,
          }));
        }
        return marker;
      } catch {
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
      }).catch(() => undefined);
    }

    window.addEventListener("keydown", handle_marker_shortcut);
    return () => window.removeEventListener("keydown", handle_marker_shortcut);
  }, [
    add_marker_and_select,
    bounded_time,
    on_update_marker,
    selected_marker_id,
  ]);

  return (
    <section className="media_timeline" aria-label="剪辑时间轴">
      <header className="media_timeline_header">
        <div className="media_timeline_heading">
          <Flag aria-hidden="true" />
          <div>
            <h2>时间线</h2>
            <p>
              {transcript_segments.length} 条转写 · {segments.length} 个事件 ·{" "}
              {markers.length} 个标记
            </p>
          </div>
        </div>
        <div className="media_timeline_header_actions">
          <output aria-label="当前播放时间和总时长">
            {format_time(bounded_time)} / {format_time(duration)}
          </output>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            aria-label={`在 ${format_time(bounded_time)} 添加标记`}
            title="添加标记（Ctrl+M）"
            onClick={() => void add_marker_and_select(bounded_time)}
          >
            <Flag data-icon="inline-start" />
            添加标记
          </Button>
        </div>
      </header>

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
                    <Trash2 data-icon="inline-start" />
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
                      <Trash2 data-icon="inline-start" />
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

      <div className="media_timeline_canvas" onKeyDown={scrub_with_keyboard}>
        <TimelineProvider engine={engine}>
          <TimelineSurface
            current_time={current_time}
            duration={duration}
            engine={engine}
            markers={markers}
            analysis_strategy={analysis_strategy}
            selected_marker_id={selected_marker_id}
            on_seek={on_seek}
            on_add_marker={add_marker_and_select}
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
              }).catch(() => undefined);
            }}
            on_select_marker={(marker_id, viewport) => {
              set_marker_selection((current) =>
                current.marker_id === marker_id
                  ? current
                  : { marker_id, viewport },
              );
              if (marker_id !== null) cancel_transcript_edit();
            }}
            on_edit_marker={edit_marker}
            on_rate_marker={(marker_id, importance) => {
              void on_update_marker(marker_id, { importance }).catch(
                () => undefined,
              );
            }}
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

      {timeline_error ? (
        <Alert className="media_timeline_error" variant="destructive">
          <AlertDescription>{timeline_error}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );

  function edit_marker(
    marker_id: string,
    pointer_position: TimelinePointerPosition,
  ) {
    const marker = markers.find(
      (candidate) => candidate.marker_id === marker_id,
    );
    if (!marker) return;
    set_marker_selection((current) => ({
      marker_id: marker.marker_id,
      viewport: current.viewport,
    }));
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
      start_seconds: marker_start_draft,
      end_seconds: marker_end_draft,
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
        set_marker_selection((current) => ({
          marker_id: null,
          viewport: current.viewport,
        }));
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
    on_seek(Math.min(Math.max(bounded_time + direction, 0), duration));
  }
}

function build_tracks(
  transcript_segments: Transcript["segments"],
  segments: MediaSegment[],
  markers: TimelineMarkerGeometry[],
  candidate_markers: MediaMarker[],
  analysis_strategy: AnalysisStrategy,
  duration: number,
  selected_marker_id: string | null,
): Track[] {
  const ordered_markers = [...markers].sort((left, right) => {
    if (left.marker_id === selected_marker_id) return -1;
    if (right.marker_id === selected_marker_id) return 1;
    return 0;
  });
  return [
    create_track(
      MARKER_TRACK_ID,
      "标记",
      "marker",
      [
        ...ordered_markers.map((marker) =>
          create_marker_clip(
            marker,
            analysis_strategy,
            duration,
            marker.marker_id === selected_marker_id,
          ),
        ),
        ...candidate_markers.map((marker) =>
          create_clip(
            `candidate-${marker.marker_id}`,
            marker.marker_id,
            marker.start_seconds,
            marker.end_seconds ??
              marker.start_seconds + MINIMUM_CLIP_DURATION_SECONDS,
            `待审批 · ${format_marker_label(marker)}`,
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

function create_marker_clip(
  marker: TimelineMarkerGeometry,
  analysis_strategy: AnalysisStrategy,
  duration: number,
  is_selected: boolean,
): Clip {
  if (marker.end_seconds !== null) {
    const clip = create_clip(
      marker.marker_id,
      marker.marker_id,
      marker.start_seconds,
      marker.end_seconds,
      "",
      {
        kind: "marker",
        source_id: marker.marker_id,
        marker_shape: "manual",
        marker_anchor_seconds: marker.start_seconds,
        rendered_start_seconds: marker.start_seconds,
      },
    );
    return invisible_marker_clip(clip);
  }

  const before_seconds = analysis_strategy.marker_range_before_seconds;
  const after_seconds = analysis_strategy.marker_range_after_seconds;
  const half_hit_duration = DEFAULT_MARKER_HIT_DURATION_SECONDS / 2;
  const rendered_start_seconds = is_selected
    ? Math.max(0, marker.start_seconds - before_seconds)
    : Math.max(0, marker.start_seconds - half_hit_duration);
  const rendered_end_seconds = is_selected
    ? Math.min(duration, marker.start_seconds + after_seconds)
    : Math.min(duration, marker.start_seconds + half_hit_duration);
  const clip = create_clip(
    marker.marker_id,
    marker.marker_id,
    rendered_start_seconds,
    rendered_end_seconds,
    "",
    {
      kind: "marker",
      source_id: marker.marker_id,
      marker_shape: "default",
      marker_anchor_seconds: marker.start_seconds,
      rendered_start_seconds,
    },
  );
  return invisible_marker_clip(clip);
}

function invisible_marker_clip(clip: Clip): Clip {
  return {
    ...clip,
    opacity: INVISIBLE_CLIP_OPACITY,
  };
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

function timeline_clip_aria_label(
  clip: Clip,
  track: Track,
  marker_labels: ReadonlyMap<string, string>,
): string {
  const metadata = clip.metadata as TimelineClipMetadata | undefined;
  if (metadata?.kind === "marker" && metadata.source_id) {
    return marker_labels.get(metadata.source_id) ?? "标记";
  }
  return clip.label || `${track.name ?? "未命名轨道"}片段`;
}

function has_same_marker_geometry(
  current: TimelineMarkerGeometry[],
  markers: MediaMarker[],
): boolean {
  return (
    current.length === markers.length &&
    current.every((geometry, index) => {
      const marker = markers[index];
      return (
        marker !== undefined &&
        geometry.marker_id === marker.marker_id &&
        geometry.start_seconds === marker.start_seconds &&
        geometry.end_seconds === marker.end_seconds
      );
    })
  );
}

function create_timeline_marker_geometry(
  markers: MediaMarker[],
): TimelineMarkerGeometry[] {
  return markers.map(({ marker_id, start_seconds, end_seconds }) => ({
    marker_id,
    start_seconds,
    end_seconds,
  }));
}

function timeline_duration(
  duration_seconds: number | null,
  current_time: number,
  transcript_segments: Transcript["segments"],
  segments: MediaSegment[],
  markers: TimelineMarkerGeometry[],
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

function current_timeline_viewport(
  engine: TimelineEngine,
): TimelineViewportState {
  return {
    zoom_scale: engine.zoomScale,
    scroll_left: engine.scrollLeft,
    scroll_top: engine.scrollTop,
  };
}

function is_text_editing_target(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "input, textarea, [contenteditable]:not([contenteditable='false'])",
    ) !== null
  );
}
