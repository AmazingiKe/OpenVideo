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
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type WheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { format_time } from "@/shared/format";
import type { MediaMarker, MediaSegment, Transcript } from "@/shared/types";

const MINIMUM_DURATION_SECONDS = 1;
const MINIMUM_CLIP_DURATION_SECONDS = 0.05;
const DEFAULT_ZOOM_SCALE = 74;
const ALT_WHEEL_ZOOM_SENSITIVITY = -0.001;
const TRACK_HEIGHT = 48;
const MARKER_TRACK_ID = "timeline-marker-track";
const TRANSCRIPT_TRACK_ID = "timeline-transcript-track";
const EVENT_TRACK_ID = "timeline-event-track";

type MediaTimelineProps = {
  duration_seconds: number | null;
  current_time: number;
  transcript: Transcript | null;
  segments: MediaSegment[];
  markers: MediaMarker[];
  marker_error: string | null;
  selected_transcript_indices: number[];
  on_seek: (seconds: number) => void;
  on_selected_transcript_indices_change: (segment_indices: number[]) => void;
  on_add_marker: (seconds: number) => Promise<void>;
  on_remove_marker: (marker_id: string) => Promise<void>;
  on_update_marker_tags: (marker_id: string, tags: string[]) => Promise<void>;
  on_update_transcript: (segment_index: number, text: string) => Promise<void>;
};

type TimelineClipMetadata = {
  kind: "marker" | "transcript" | "event";
  source_id?: string;
  source_index?: number;
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
  on_seek: (seconds: number) => void;
  on_add_marker: (seconds: number) => Promise<void>;
  on_select_marker: (marker_id: string) => void;
  on_select_transcript: (segment_index: number | null) => void;
  on_edit_transcript: (segment_index: number) => void;
};

function TimelineSurface({
  current_time,
  duration,
  engine,
  on_seek,
  on_add_marker,
  on_select_marker,
  on_select_transcript,
  on_edit_transcript,
}: TimelineSurfaceProps) {
  const syncing_playhead_ref = useRef(false);

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
          on_select_marker(metadata.source_id);
        }
        on_select_transcript(
          metadata?.kind === "transcript" &&
            metadata.source_index !== undefined
            ? metadata.source_index
            : null,
        );
      }),
    [engine, on_seek, on_select_marker, on_select_transcript],
  );

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

  return (
    <div className="timeline-shell">
      <div className="timeline-stage">
        <Timeline.Root
          className="timeline-fill"
          aria-label="时间线画布；拖动平移，Alt 加滚轮缩放，方向键定位"
          onContextMenu={add_marker_at_pointer}
          onWheelCapture={zoom_with_alt}
        >
          <CanvasRenderer />
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
      <div className="timeline-scrollbar-row">
        <Timeline.ViewportScrollbar aria-label="时间线可见范围">
          <Timeline.ViewportScrollbarThumb>
            <Timeline.ViewportScrollbarHandle side="start" />
            <Timeline.ViewportScrollbarHandle side="end" />
          </Timeline.ViewportScrollbarThumb>
        </Timeline.ViewportScrollbar>
      </div>
    </div>
  );
}

export function MediaTimeline({
  duration_seconds,
  current_time,
  transcript,
  segments,
  markers,
  marker_error,
  selected_transcript_indices,
  on_seek,
  on_selected_transcript_indices_change,
  on_add_marker,
  on_remove_marker,
  on_update_marker_tags,
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
  const [marker_tags_draft, set_marker_tags_draft] = useState("");
  const transcript_segments = useMemo(
    () => transcript?.segments ?? [],
    [transcript],
  );
  const selected_transcript_index_set = useMemo(
    () => new Set(selected_transcript_indices),
    [selected_transcript_indices],
  );
  const duration = timeline_duration(
    duration_seconds,
    current_time,
    transcript_segments,
    segments,
    markers,
  );
  const tracks = useMemo(
    () =>
      build_tracks(
        transcript_segments,
        segments,
        markers,
        selected_transcript_index_set,
      ),
    [markers, segments, selected_transcript_index_set, transcript_segments],
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

      {editing_marker_id !== null ? (
        <form
          className="media_timeline_editor"
          onSubmit={(event) => void save_marker_tags(event)}
        >
          <Input
            autoFocus
            aria-label="编辑标记标签"
            value={marker_tags_draft}
            placeholder="重点, 公式"
            onChange={(event) =>
              set_marker_tags_draft(event.currentTarget.value)
            }
          />
          <Button type="submit" size="xs">
            保存
          </Button>
          <Button
            type="button"
            size="xs"
            variant="destructive"
            onClick={() => void delete_marker()}
          >
            删除
          </Button>
          <Button
            type="button"
            size="xs"
            variant="secondary"
            onClick={() => set_editing_marker_id(null)}
          >
            关闭
          </Button>
        </form>
      ) : null}

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
            on_seek={on_seek}
            on_add_marker={on_add_marker}
            on_select_marker={select_marker}
            on_select_transcript={(segment_index) =>
              on_selected_transcript_indices_change(
                segment_index === null ? [] : [segment_index],
              )
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

  function select_marker(marker_id: string) {
    const marker = markers.find(
      (candidate) => candidate.marker_id === marker_id,
    );
    if (!marker) return;
    set_editing_marker_id(marker.marker_id);
    set_marker_tags_draft(marker.tags.join(", "));
    cancel_transcript_edit();
  }

  function edit_transcript(segment_index: number) {
    const segment = transcript_segments[segment_index];
    if (!segment) return;
    set_editing_marker_id(null);
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

  async function save_marker_tags(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editing_marker_id === null) return;
    const tags = marker_tags_draft
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    await on_update_marker_tags(editing_marker_id, tags);
    set_editing_marker_id(null);
  }

  async function delete_marker() {
    if (editing_marker_id === null) return;
    await on_remove_marker(editing_marker_id);
    set_editing_marker_id(null);
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
  selected_transcript_indices: Set<number>,
): Track[] {
  return [
    create_track(
      MARKER_TRACK_ID,
      "标记",
      "marker",
      markers.map((marker) =>
        create_clip(
          marker.marker_id,
          marker.marker_id,
          marker.time_seconds,
          marker.time_seconds + MINIMUM_CLIP_DURATION_SECONDS,
          marker.tags.join(" · ") || "未添加标签",
          { kind: "marker", source_id: marker.marker_id },
        ),
      ),
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
          selected_transcript_indices.has(index),
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
): Track {
  return {
    id,
    name,
    kind,
    clips,
    selected: false,
    locked: true,
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
  selected = false,
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
    selected,
    label,
    movable: false,
    resizable: false,
    metadata,
  };
}

function build_markers(markers: MediaMarker[]): Marker[] {
  return markers.map((marker) => ({
    id: marker.marker_id,
    time: fromSeconds(marker.time_seconds),
    label: marker.tags.join(" · ") || "标记",
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
    ...markers.map((marker) => marker.time_seconds),
    MINIMUM_DURATION_SECONDS,
  );
}

function is_text_editing_target(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("input, textarea, [contenteditable='true']") !== null
  );
}
