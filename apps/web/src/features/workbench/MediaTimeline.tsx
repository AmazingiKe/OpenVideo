import { Timeline, type TimelineEditor } from "@xzdarcy/react-timeline-editor";
import "@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css";
import {
  Captions,
  Crosshair,
  Flag,
  LockKeyhole,
  Pencil,
  ScanSearch,
  WandSparkles,
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
  type ReactNode,
} from "react";

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
} from "@/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { format_marker_importance } from "@/shared/marker_labels";
import type {
  AnalysisStrategy,
  EventAnalysis,
  FocusSelection,
  MarkerImportance,
  MediaMarker,
  MediaMarkerUpdate,
  MediaSegment,
  Transcript,
} from "@/shared/types";
import { TimelineRulerCanvas } from "./TimelineRulerCanvas";
import { EventAnalysisCard } from "./EventAnalysisCard";
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
const EMPTY_EVENT_ANALYSES: EventAnalysis[] = [];
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
    name: "全片分析",
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
  focus_selection?: FocusSelection | null;
  event_analyses?: EventAnalysis[];
  selected_marker_ids?: Set<string>;
  selected_transcript_indices: number[];
  analysis_strategy: AnalysisStrategy;
  marker_error: string | null;
  on_scrub: (seconds: number) => void;
  on_seek: (seconds: number) => void;
  on_toggle_playback: () => void;
  on_playback_rate_change: (rate: number) => void;
  on_selected_transcript_indices_change: (segment_indices: number[]) => void;
  on_request_transcript_correction: (segment_indices: number[]) => void;
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
  on_selected_marker_ids_change?: (marker_ids: Set<string>) => void;
  on_set_focus_in?: (seconds: number) => void;
  on_set_focus_out?: (seconds: number) => void;
  on_clear_focus?: () => void;
  on_delete_event_analysis?: (event_analysis_id: string) => Promise<void>;
  toolbar_tools: ReactNode;
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
  focus_selection = null,
  event_analyses = EMPTY_EVENT_ANALYSES,
  selected_marker_ids,
  selected_transcript_indices,
  analysis_strategy,
  marker_error,
  on_scrub,
  on_seek,
  on_toggle_playback,
  on_playback_rate_change,
  on_selected_transcript_indices_change,
  on_request_transcript_correction,
  on_add_marker,
  on_update_marker,
  on_delete_marker,
  on_update_transcript,
  on_selected_marker_ids_change,
  on_set_focus_in,
  on_set_focus_out,
  on_clear_focus,
  on_delete_event_analysis,
  toolbar_tools,
}: MediaTimelineProps) {
  const [selected_marker_id, set_selected_marker_id] = useState<string | null>(
    null,
  );
  const [context_marker_id, set_context_marker_id] = useState<string | null>(
    null,
  );
  const [context_transcript_indices, set_context_transcript_indices] = useState<
    number[]
  >([]);
  const [interaction_revision, set_interaction_revision] = useState(0);
  const [interaction_error, set_interaction_error] = useState<string | null>(
    null,
  );
  const [selected_event_analysis_ids, set_selected_event_analysis_ids] =
    useState<string[]>([]);
  const [delete_analysis, set_delete_analysis] = useState<EventAnalysis | null>(
    null,
  );
  const ruler_pointer_id_ref = useRef<number | null>(null);
  const ruler_scrub_time_ref = useRef(0);
  const transcript_segments = useMemo(
    () => transcript?.segments ?? [],
    [transcript],
  );
  const selected_transcript_index_set = useMemo(
    () => new Set(selected_transcript_indices),
    [selected_transcript_indices],
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
        selected_marker_ids,
        selected_transcript_indices: selected_transcript_index_set,
        focus_selection,
        event_analyses,
      }),
    // 第三方编辑器会修改 action；保存失败时必须用新对象覆盖其本地变更。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      analysis_strategy,
      candidate_markers,
      duration,
      event_analyses,
      focus_selection,
      interaction_revision,
      markers,
      segments,
      selected_marker_id,
      selected_marker_ids,
      selected_transcript_index_set,
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
  const selected_event_analyses = event_analyses.filter((analysis) =>
    selected_event_analysis_ids.includes(analysis.event_analysis_id),
  );
  const track_presentations = [
    ...TIMELINE_TRACK_PRESENTATIONS,
    ...(full_editor_data.some((row) => row.id === TIMELINE_TRACK_IDS.focus)
      ? [
          {
            id: TIMELINE_TRACK_IDS.focus,
            icon: Crosshair,
            name: "焦点选区",
            state: "只读" as const,
          },
        ]
      : []),
    ...full_editor_data
      .filter((row) =>
        row.id.startsWith(TIMELINE_TRACK_IDS.event_analysis_prefix),
      )
      .map((row, index) => ({
        id: row.id,
        icon: ScanSearch,
        name: index === 0 ? "事件分析" : `事件分析 ${index + 1}`,
        state: "只读" as const,
      })),
  ];

  useEffect(() => {
    set_selected_marker_id(null);
    set_context_marker_id(null);
    set_context_transcript_indices([]);
    set_interaction_error(null);
    set_selected_event_analysis_ids([]);
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
        if (marker) {
          set_selected_marker_id(marker.marker_id);
          on_selected_marker_ids_change?.(new Set([marker.marker_id]));
        }
        return marker;
      } catch {
        set_interaction_error("标记添加失败，请稍后重试");
        return undefined;
      }
    },
    [on_add_marker, on_selected_marker_ids_change],
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
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        const key = event.key.toLowerCase();
        if (key === "i") {
          event.preventDefault();
          on_set_focus_in?.(bounded_time);
          return;
        }
        if (key === "o") {
          event.preventDefault();
          on_set_focus_out?.(bounded_time);
          return;
        }
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
    on_set_focus_in,
    on_set_focus_out,
    selected_marker_id,
  ]);

  function select_action(action: TimelineAction, toggle_selection = false) {
    const media_action = action as MediaTimelineAction;
    const { data } = media_action;
    set_interaction_error(null);
    if (data.kind === "marker" && data.source_id) {
      set_selected_marker_id(data.source_id);
      const next_selection = toggle_selection
        ? toggle_marker_selection(
            selected_marker_ids ?? new Set<string>(),
            data.source_id,
          )
        : new Set([data.source_id]);
      on_selected_marker_ids_change?.(next_selection);
      on_selected_transcript_indices_change([]);
      on_seek(data.marker_anchor_seconds ?? media_action.start);
      cancel_transcript_edit();
      return;
    }
    if (data.kind === "event_analysis" && data.event_analysis_ids) {
      set_selected_event_analysis_ids(data.event_analysis_ids);
      on_selected_transcript_indices_change([]);
      on_seek(media_action.start);
      return;
    }
    set_selected_marker_id(null);
    on_selected_marker_ids_change?.(new Set());
    on_seek(media_action.start);
    if (data.kind === "transcript" && data.source_index !== undefined) {
      const next_selection = toggle_selection
        ? toggle_transcript_selection(
            selected_transcript_indices,
            data.source_index,
          )
        : [data.source_index];
      on_selected_transcript_indices_change(next_selection);
      return;
    }
    on_selected_transcript_indices_change([]);
  }

  function open_action_editor(
    action: TimelineAction,
    pointer_position: TimelinePointerPosition,
  ) {
    const data = (action as MediaTimelineAction).data;
    if (data.kind === "marker" && data.source_id) {
      on_selected_marker_ids_change?.(new Set([data.source_id]));
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
    set_context_marker_id(null);
    set_context_transcript_indices([]);
    if (data.kind === "marker" && data.source_id) {
      set_context_marker_id(data.source_id);
      set_selected_marker_id(data.source_id);
      on_selected_marker_ids_change?.(new Set([data.source_id]));
      on_selected_transcript_indices_change([]);
      on_seek(data.marker_anchor_seconds ?? action.start);
      return;
    }
    if (data.kind === "transcript" && data.source_index !== undefined) {
      const context_selection = selected_transcript_index_set.has(
        data.source_index,
      )
        ? selected_transcript_indices
        : [data.source_index];
      set_context_transcript_indices(context_selection);
      set_selected_marker_id(null);
      on_selected_marker_ids_change?.(new Set());
      on_selected_transcript_indices_change(context_selection);
      on_seek(action.start);
      return;
    }
    event.preventDefault();
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
        on_set_focus_in={(seconds) => on_set_focus_in?.(seconds)}
        on_set_focus_out={(seconds) => on_set_focus_out?.(seconds)}
        on_clear_focus={() => on_clear_focus?.()}
        has_focus_selection={focus_selection !== null}
        tools={toolbar_tools}
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
          {track_presentations.map((track) => {
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
                  select_action(action, event.ctrlKey || event.metaKey);
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
          ) : context_transcript_indices.length > 0 ? (
            <ContextMenuContent className="min-w-48">
              <ContextMenuLabel>
                {context_transcript_indices.length === 1
                  ? "字幕"
                  : `已选择 ${context_transcript_indices.length} 条字幕`}
              </ContextMenuLabel>
              <ContextMenuGroup>
                <ContextMenuItem
                  onSelect={() =>
                    on_request_transcript_correction(context_transcript_indices)
                  }
                >
                  <WandSparkles aria-hidden="true" />
                  修正字幕
                </ContextMenuItem>
                {context_transcript_indices.length === 1 ? (
                  <ContextMenuItem
                    onSelect={() => {
                      const transcript_index = context_transcript_indices[0];
                      if (transcript_index !== undefined) {
                        edit_transcript(transcript_index);
                      }
                    }}
                  >
                    <Pencil aria-hidden="true" />
                    编辑文字
                    <ContextMenuShortcut>Enter</ContextMenuShortcut>
                  </ContextMenuItem>
                ) : null}
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
      <Sheet
        open={selected_event_analysis_ids.length > 0}
        onOpenChange={(open) => {
          if (!open) set_selected_event_analysis_ids([]);
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>事件分析结果</SheetTitle>
            <SheetDescription>
              同一目标的历史结果会一起展示，过期结果仍可追溯。
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-3 px-4 pb-4">
            {selected_event_analyses.map((analysis) => (
              <EventAnalysisCard
                key={analysis.event_analysis_id}
                analysis={analysis}
                on_seek={on_seek}
                on_delete={set_delete_analysis}
              />
            ))}
          </div>
        </SheetContent>
      </Sheet>
      <AlertDialog
        open={delete_analysis !== null}
        onOpenChange={(open) => {
          if (!open) set_delete_analysis(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除事件分析？</AlertDialogTitle>
            <AlertDialogDescription>
              结果会从资料库中移除，此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!delete_analysis || !on_delete_event_analysis) return;
                void on_delete_event_analysis(delete_analysis.event_analysis_id)
                  .then(() => {
                    set_selected_event_analysis_ids((current) =>
                      current.filter(
                        (id) => id !== delete_analysis.event_analysis_id,
                      ),
                    );
                    set_delete_analysis(null);
                  })
                  .catch(() =>
                    set_interaction_error("事件分析删除失败，请稍后重试"),
                  );
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
      "input, textarea, [role='combobox'], [contenteditable]:not([contenteditable='false'])",
    ) !== null
  );
}

function toggle_marker_selection(
  current: Set<string>,
  marker_id: string,
): Set<string> {
  const next = new Set(current);
  if (next.has(marker_id)) next.delete(marker_id);
  else next.add(marker_id);
  return next;
}

function toggle_transcript_selection(
  current: number[],
  transcript_index: number,
): number[] {
  return current.includes(transcript_index)
    ? current.filter((index) => index !== transcript_index)
    : [...current, transcript_index].sort((left, right) => left - right);
}
