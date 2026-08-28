import { Timeline, type TimelineEditor } from "@xzdarcy/react-timeline-editor";
import "@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css";
import {
  Captions,
  Flag,
  LockKeyhole,
  ScanSearch,
  type LucideIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { format_marker_importance } from "@/shared/marker_labels";
import type {
  AnalysisStrategy,
  MarkerImportance,
  MediaMarker,
  MediaMarkerUpdate,
  MediaSegment,
  Transcript,
} from "@/shared/types";
import { TimelineRulerCanvas } from "./TimelineRulerCanvas";
import { MediaTimelineMarkerEditor } from "./MediaTimelineMarkerEditor";
import { MediaTimelineActionContent } from "./MediaTimelineActionContent";
import { MediaTimelineToolbar } from "./MediaTimelineToolbar";
import { MediaTimelineTranscriptEditor } from "./MediaTimelineTranscriptEditor";
import {
  MARKER_SHAPE_VALUES,
  MINIMUM_ACTION_DURATION_SECONDS,
  TIMELINE_ROW_HEIGHT,
  TIMELINE_START_LEFT,
  TIMELINE_TRACK_IDS,
  build_timeline_rows,
  filter_timeline_rows_for_window,
  round_marker_time,
  timeline_content_duration,
  type MediaTimelineAction,
  type TimelineAction,
} from "./media_timeline_calculations";
import {
  use_media_timeline_editors,
  type TimelinePointerPosition,
} from "./use_media_timeline_editors";
import { use_media_timeline_viewport } from "./use_media_timeline_viewport";

const TIMELINE_SCALE_SECONDS = 1;
const TIMELINE_SCALE_SPLIT_COUNT = 1;
const EMPTY_MARKERS: MediaMarker[] = [];
const EMPTY_TIMELINE_EFFECTS: TimelineEditor["effects"] = {};
const MARKER_IMPORTANCE_VALUES: MarkerImportance[] = [0, 1, 2, 3, 4, 5];

type TimelineTrackPresentation = {
  id: string;
  icon: LucideIcon;
  name: string;
  state: "可编辑" | "只读";
};

const TIMELINE_TRACK_PRESENTATIONS: TimelineTrackPresentation[] = [
  {
    id: TIMELINE_TRACK_IDS.marker,
    icon: Flag,
    name: "标记",
    state: "可编辑",
  },
  {
    id: TIMELINE_TRACK_IDS.transcript,
    icon: Captions,
    name: "转写",
    state: "只读",
  },
  {
    id: TIMELINE_TRACK_IDS.event,
    icon: ScanSearch,
    name: "分析事件",
    state: "只读",
  },
];

type MediaTimelineProps = {
  asset_id: string | null;
  duration_seconds: number | null;
  current_time: number;
  read_playback_time?: () => number;
  is_paused: boolean;
  playback_rate: number;
  transcript: Transcript | null;
  segments: MediaSegment[];
  markers: MediaMarker[];
  candidate_markers?: MediaMarker[];
  analysis_strategy: AnalysisStrategy;
  marker_error: string | null;
  on_scrub: (seconds: number) => void;
  on_seek: (seconds: number) => void;
  on_toggle_playback: () => void;
  on_playback_rate_change: (rate: number) => void;
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

export function MediaTimeline({
  asset_id,
  duration_seconds,
  current_time,
  read_playback_time,
  is_paused,
  playback_rate,
  transcript,
  segments,
  markers,
  candidate_markers = EMPTY_MARKERS,
  analysis_strategy,
  marker_error,
  on_scrub,
  on_seek,
  on_toggle_playback,
  on_playback_rate_change,
  on_selected_transcript_indices_change,
  on_add_marker,
  on_update_marker,
  on_delete_marker,
  on_update_transcript,
}: MediaTimelineProps) {
  const [selected_marker_id, set_selected_marker_id] = useState<string | null>(
    null,
  );
  const [context_marker_id, set_context_marker_id] = useState<string | null>(
    null,
  );
  const [interaction_revision, set_interaction_revision] = useState(0);
  const [interaction_error, set_interaction_error] = useState<string | null>(
    null,
  );
  const ruler_pointer_id_ref = useRef<number | null>(null);
  const ruler_scrub_time_ref = useRef(0);
  const transcript_segments = useMemo(
    () => transcript?.segments ?? [],
    [transcript],
  );
  const {
    cancel_marker_edit,
    cancel_transcript_edit,
    delete_marker,
    edit_marker,
    edit_transcript,
    editing_marker_id,
    editing_transcript_index,
    is_saving_marker,
    is_saving_transcript,
    marker_editor_position,
    marker_end_draft,
    marker_save_error,
    marker_start_draft,
    save_marker,
    save_transcript,
    set_marker_end_draft,
    set_marker_start_draft,
    set_transcript_draft,
    transcript_draft,
    transcript_error,
  } = use_media_timeline_editors({
    asset_id,
    markers,
    on_delete_marker,
    on_select_marker: set_selected_marker_id,
    on_update_marker,
    on_update_transcript,
    transcript_segments,
  });
  const content_duration = useMemo(
    () =>
      timeline_content_duration(
        duration_seconds,
        transcript_segments,
        segments,
        markers,
        candidate_markers,
      ),
    [
      candidate_markers,
      duration_seconds,
      markers,
      segments,
      transcript_segments,
    ],
  );
  const duration = Math.max(content_duration, current_time);
  const bounded_time = Math.min(Math.max(current_time, 0), duration);
  const scale_count = Math.max(1, Math.ceil(duration));
  const {
    canvas_width,
    editor_render_window,
    handle_timeline_scroll,
    playhead_ref,
    set_playhead_time,
    timeline_host_ref,
    timeline_ref,
    viewport,
    zoom_to,
    zoom_with_alt,
  } = use_media_timeline_viewport({
    asset_id,
    bounded_time,
    duration,
    is_paused,
    playback_rate,
    read_playback_time,
  });
  const full_editor_data = useMemo(
    () =>
      build_timeline_rows({
        transcript_segments,
        segments,
        markers,
        candidate_markers,
        analysis_strategy,
        duration,
        selected_marker_id,
      }),
    // 第三方编辑器会修改 action；保存失败时必须用新对象覆盖其本地变更。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      analysis_strategy,
      candidate_markers,
      duration,
      interaction_revision,
      markers,
      segments,
      selected_marker_id,
      transcript_segments,
    ],
  );
  const editor_data = useMemo(
    () =>
      filter_timeline_rows_for_window(full_editor_data, editor_render_window),
    [editor_render_window, full_editor_data],
  );
  const context_marker = markers.find(
    (marker) => marker.marker_id === context_marker_id,
  );
  const timeline_error = interaction_error ?? transcript_error ?? marker_error;

  useEffect(() => {
    set_selected_marker_id(null);
    set_context_marker_id(null);
    set_interaction_error(null);
  }, [asset_id]);

  const add_marker_and_select = useCallback(
    async (
      start_seconds: number,
      end_seconds: number | null = null,
    ): Promise<MediaMarker | undefined> => {
      try {
        const marker = await on_add_marker(
          round_marker_time(start_seconds),
          end_seconds === null ? null : round_marker_time(end_seconds),
        );
        if (marker) set_selected_marker_id(marker.marker_id);
        return marker;
      } catch {
        set_interaction_error("标记添加失败，请稍后重试");
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
      }).catch(() => set_interaction_error("标记评分保存失败，请稍后重试"));
    }

    window.addEventListener("keydown", handle_marker_shortcut);
    return () => window.removeEventListener("keydown", handle_marker_shortcut);
  }, [
    add_marker_and_select,
    bounded_time,
    on_update_marker,
    selected_marker_id,
  ]);

  function select_action(action: TimelineAction) {
    const media_action = action as MediaTimelineAction;
    const { data } = media_action;
    set_interaction_error(null);
    if (data.kind === "marker" && data.source_id) {
      set_selected_marker_id(data.source_id);
      on_seek(data.marker_anchor_seconds ?? media_action.start);
      cancel_transcript_edit();
      return;
    }
    set_selected_marker_id(null);
    on_seek(media_action.start);
    if (data.kind === "transcript" && data.source_index !== undefined) {
      on_selected_transcript_indices_change([data.source_index]);
    }
  }

  function open_action_editor(
    action: TimelineAction,
    pointer_position: TimelinePointerPosition,
  ) {
    const data = (action as MediaTimelineAction).data;
    if (data.kind === "marker" && data.source_id) {
      edit_marker(data.source_id, pointer_position);
      return;
    }
    if (data.kind === "transcript" && data.source_index !== undefined) {
      on_selected_transcript_indices_change([data.source_index]);
      edit_transcript(data.source_index);
    }
  }

  function prepare_action_context_menu(
    event: MouseEvent<HTMLElement>,
    action: TimelineAction,
  ) {
    const data = (action as MediaTimelineAction).data;
    if (data.kind !== "marker" || !data.source_id) {
      event.preventDefault();
      return;
    }
    set_context_marker_id(data.source_id);
    set_selected_marker_id(data.source_id);
    on_seek(data.marker_anchor_seconds ?? action.start);
  }

  async function persist_marker_bounds(
    action: TimelineAction,
    start_seconds: number,
    end_seconds: number,
    interaction: "move" | "resize",
  ) {
    const data = (action as MediaTimelineAction).data;
    if (data.kind !== "marker" || !data.source_id) return;
    const marker = markers.find((item) => item.marker_id === data.source_id);
    if (!marker) return;

    let next_start = start_seconds;
    let next_end: number | null = end_seconds;
    if (
      data.marker_shape === MARKER_SHAPE_VALUES.point &&
      interaction === "move" &&
      data.marker_anchor_seconds !== undefined &&
      data.rendered_start_seconds !== undefined
    ) {
      const movement = start_seconds - data.rendered_start_seconds;
      next_start = data.marker_anchor_seconds + movement;
      next_end = null;
    }
    next_start = round_marker_time(Math.min(Math.max(next_start, 0), duration));
    if (next_end !== null) {
      next_end = round_marker_time(Math.min(Math.max(next_end, 0), duration));
      if (next_end <= next_start) {
        next_end = Math.min(
          duration,
          next_start + MINIMUM_ACTION_DURATION_SECONDS,
        );
      }
    }

    set_interaction_error(null);
    try {
      await on_update_marker(data.source_id, {
        start_seconds: next_start,
        end_seconds: next_end,
      });
    } catch {
      set_interaction_revision((revision) => revision + 1);
      set_interaction_error("标记时间保存失败，已恢复原位置");
    }
  }

  return (
    <section className="media_timeline" aria-label="剪辑时间轴">
      <MediaTimelineToolbar
        current_time={bounded_time}
        duration={duration}
        is_paused={is_paused}
        playback_rate={playback_rate}
        zoom_pixels_per_second={viewport.zoom_pixels_per_second}
        on_toggle_playback={on_toggle_playback}
        on_playback_rate_change={on_playback_rate_change}
        on_add_marker={(seconds) => void add_marker_and_select(seconds)}
        on_zoom_change={zoom_to}
      />

      <MediaTimelineTranscriptEditor
        editing_transcript_index={editing_transcript_index}
        transcript_draft={transcript_draft}
        is_saving_transcript={is_saving_transcript}
        set_transcript_draft={set_transcript_draft}
        save_transcript={save_transcript}
        cancel_transcript_edit={cancel_transcript_edit}
      />

      <MediaTimelineMarkerEditor
        editing_marker_id={editing_marker_id}
        marker_editor_position={marker_editor_position}
        duration={duration}
        marker_start_draft={marker_start_draft}
        marker_end_draft={marker_end_draft}
        marker_save_error={marker_save_error}
        is_saving_marker={is_saving_marker}
        set_marker_start_draft={set_marker_start_draft}
        set_marker_end_draft={set_marker_end_draft}
        cancel_marker_edit={cancel_marker_edit}
        save_marker={save_marker}
        delete_marker={delete_marker}
      />

      <div className="media_timeline_editor_shell">
        <aside className="media_timeline_track_labels" aria-label="时间线轨道">
          <div className="media_timeline_track_labels_header">轨道</div>
          {TIMELINE_TRACK_PRESENTATIONS.map((track) => {
            const TrackIcon = track.icon;
            return (
              <div
                key={track.id}
                className="media_timeline_track_label"
                aria-label={`${track.name}，${track.state}`}
              >
                <TrackIcon aria-hidden="true" />
                <span>{track.name}</span>
                <small>{track.state}</small>
                {track.state === "只读" ? (
                  <LockKeyhole aria-hidden="true" />
                ) : null}
              </div>
            );
          })}
        </aside>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              ref={timeline_host_ref}
              className="media_timeline_canvas"
              onWheelCapture={zoom_with_alt}
              aria-label="时间线画布；双击标记轨道空白处添加标记，Enter 编辑片段，Shift+F10 打开菜单"
            >
              <TimelineRulerCanvas
                canvas_width={canvas_width}
                duration_seconds={duration}
                scroll_left={viewport.scroll_left}
                start_left={TIMELINE_START_LEFT}
                zoom_pixels_per_second={viewport.zoom_pixels_per_second}
              />
              <div
                className="timeline_ruler_interaction"
                role="slider"
                tabIndex={0}
                aria-label="时间线播放头"
                aria-description="点击或拖动以定位播放时间"
                aria-valuemin={0}
                aria-valuemax={duration}
                aria-valuenow={bounded_time}
                aria-valuetext={format_ruler_accessible_time(bounded_time)}
                onKeyDown={scrub_with_keyboard}
                onPointerDown={start_ruler_scrub}
                onPointerMove={continue_ruler_scrub}
                onPointerUp={finish_ruler_scrub}
                onPointerCancel={cancel_ruler_scrub}
              />
              <div
                ref={playhead_ref}
                className="media_timeline_playhead"
                data-visible="false"
                aria-hidden="true"
              />
              <Timeline
                ref={timeline_ref}
                editorData={editor_data}
                effects={EMPTY_TIMELINE_EFFECTS}
                scale={TIMELINE_SCALE_SECONDS}
                scaleWidth={viewport.zoom_pixels_per_second}
                scaleSplitCount={TIMELINE_SCALE_SPLIT_COUNT}
                minScaleCount={scale_count}
                maxScaleCount={scale_count}
                startLeft={TIMELINE_START_LEFT}
                rowHeight={TIMELINE_ROW_HEIGHT}
                gridSnap={false}
                dragLine={false}
                autoScroll
                autoReRender={false}
                hideCursor
                getActionRender={(action) => (
                  <MediaTimelineActionContent
                    action={action}
                    open_action_editor={open_action_editor}
                  />
                )}
                onScroll={handle_timeline_scroll}
                onChange={() => false}
                onClickTimeArea={(time) => {
                  on_seek_bounded(time);
                  return true;
                }}
                onClickActionOnly={(event, { action }) => {
                  event.stopPropagation();
                  select_action(action);
                }}
                onDoubleClickAction={(event, { action }) => {
                  event.stopPropagation();
                  open_action_editor(action, {
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
                onContextMenuAction={(event, { action }) =>
                  prepare_action_context_menu(event, action)
                }
                onDoubleClickRow={(event, { row, time }) => {
                  if (row.id !== TIMELINE_TRACK_IDS.marker) return;
                  event.preventDefault();
                  void add_marker_and_select(
                    Math.min(Math.max(time, 0), duration),
                  );
                }}
                onActionMoveEnd={({ action, start, end }) => {
                  void persist_marker_bounds(action, start, end, "move");
                }}
                onActionResizeEnd={({ action, start, end }) => {
                  void persist_marker_bounds(action, start, end, "resize");
                }}
              />
            </div>
          </ContextMenuTrigger>
          {context_marker ? (
            <ContextMenuContent className="min-w-48">
              <ContextMenuGroup>
                <ContextMenuLabel>标记重要程度</ContextMenuLabel>
                <ContextMenuRadioGroup
                  value={String(context_marker.importance)}
                  onValueChange={(value) => {
                    void on_update_marker(context_marker.marker_id, {
                      importance: Number(value) as MarkerImportance,
                    }).catch(() =>
                      set_interaction_error("标记评分保存失败，请稍后重试"),
                    );
                  }}
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

      {timeline_error ? (
        <Alert className="media_timeline_error" variant="destructive">
          <AlertDescription>{timeline_error}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );

  function on_seek_bounded(seconds: number) {
    on_seek(Math.min(Math.max(seconds, 0), duration));
  }

  function on_scrub_bounded(seconds: number) {
    on_scrub(Math.min(Math.max(seconds, 0), duration));
  }

  function ruler_time_from_pointer(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointer_x = event.clientX - bounds.left;
    return Math.min(
      Math.max(
        (viewport.scroll_left + pointer_x - TIMELINE_START_LEFT) /
          viewport.zoom_pixels_per_second,
        0,
      ),
      duration,
    );
  }

  function start_ruler_scrub(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || ruler_pointer_id_ref.current !== null) return;
    event.preventDefault();
    ruler_pointer_id_ref.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    const time = ruler_time_from_pointer(event);
    ruler_scrub_time_ref.current = time;
    set_playhead_time(time);
    on_scrub_bounded(time);
  }

  function continue_ruler_scrub(event: PointerEvent<HTMLDivElement>) {
    if (ruler_pointer_id_ref.current !== event.pointerId) return;
    const time = ruler_time_from_pointer(event);
    ruler_scrub_time_ref.current = time;
    set_playhead_time(time);
    on_scrub_bounded(time);
  }

  function finish_ruler_scrub(event: PointerEvent<HTMLDivElement>) {
    if (ruler_pointer_id_ref.current !== event.pointerId) return;
    const time = ruler_time_from_pointer(event);
    ruler_pointer_id_ref.current = null;
    ruler_scrub_time_ref.current = time;
    event.currentTarget.releasePointerCapture(event.pointerId);
    set_playhead_time(time);
    on_seek_bounded(time);
  }

  function cancel_ruler_scrub(event: PointerEvent<HTMLDivElement>) {
    if (ruler_pointer_id_ref.current !== event.pointerId) return;
    ruler_pointer_id_ref.current = null;
    on_seek_bounded(ruler_scrub_time_ref.current);
  }

  function scrub_with_keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Home") {
      event.preventDefault();
      on_seek_bounded(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      on_seek_bounded(duration);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    on_seek_bounded(bounded_time + direction);
  }
}

function format_ruler_accessible_time(seconds: number): string {
  return `${round_marker_time(seconds).toFixed(2)} 秒`;
}

function is_text_editing_target(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "input, textarea, [contenteditable]:not([contenteditable='false'])",
    ) !== null
  );
}
