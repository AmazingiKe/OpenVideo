import {
  Timeline,
  type TimelineEditor,
  type TimelineState,
} from "@xzdarcy/react-timeline-editor";
import "@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css";
import {
  Bot,
  Captions,
  Flag,
  LockKeyhole,
  Pencil,
  ScanSearch,
  type LucideIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  memo,
} from "react";

import { AgentContextSource } from "@/components/AgentContextSource";
import {
  renew_context_attachment_draft,
  type AgentContextAttachmentDraft,
} from "@/components/agent_context";
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
  ContextMenuSeparator,
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
import { format_time } from "@/shared/format";
import { format_marker_importance } from "@/shared/marker_labels";
import type {
  AnalysisStrategy,
  AgentEvidenceRange,
  EventAnalysis,
  FocusSelection,
  MarkerImportance,
  MediaMarker,
  MediaMarkerUpdate,
  MediaSegment,
  Transcript,
} from "@/shared/types";
import {
  TimelineGrid,
  TimelineRulerCanvas,
  select_timeline_ruler_interval,
} from "./TimelineRulerCanvas";
import { EventAnalysisCard } from "./EventAnalysisCard";
import { MediaTimelineMarkerEditor } from "./MediaTimelineMarkerEditor";
import { MediaTimelineActionContent } from "./MediaTimelineActionContent";
import {
  MediaTimelineLodCanvas,
  TIMELINE_LOD_VALUES,
  select_timeline_lod,
  timeline_lod_label,
  type TimelineLod,
} from "./MediaTimelineLodCanvas";
import { MediaTimelineToolbar } from "./MediaTimelineToolbar";
import { MediaTimelineTranscriptEditor } from "./MediaTimelineTranscriptEditor";
import {
  MARKER_SHAPE_VALUES,
  MINIMUM_ACTION_DURATION_SECONDS,
  TIMELINE_MAXIMUM_ROW_HEIGHT,
  TIMELINE_MINIMUM_ROW_HEIGHT,
  TIMELINE_ROW_HEIGHT,
  TIMELINE_START_LEFT,
  TIMELINE_TRACK_IDS,
  build_timeline_rows,
  clamp_timeline_row_height,
  default_timeline_row_height,
  filter_timeline_rows_for_window,
  hit_test_timeline_marquee,
  normalize_marker_time,
  selected_timeline_range,
  timeline_content_duration,
  type MediaTimelineAction,
  type TimelineMarqueeRectangle,
  type TimelineAction,
} from "./media_timeline_calculations";
import {
  use_media_timeline_editors,
  type TimelinePointerPosition,
} from "./use_media_timeline_editors";
import { use_media_timeline_viewport } from "./use_media_timeline_viewport";
import { use_media_timeline_marquee } from "./use_media_timeline_marquee";
import {
  focus_context_attachment,
  transcript_context_attachment,
} from "./timeline_agent_context";

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

type TimelineTrackResizeHandleProps = {
  height: number;
  name: string;
  on_height_change: (height: number) => void;
  on_height_reset: () => void;
};

const TIMELINE_ROW_KEYBOARD_RESIZE_STEP = 8;

function TimelineTrackResizeHandle({
  height,
  name,
  on_height_change,
  on_height_reset,
}: TimelineTrackResizeHandleProps) {
  const drag_ref = useRef<{ pointer_y: number; height: number } | null>(null);

  function start_resize(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    drag_ref.current = { pointer_y: event.clientY, height };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function continue_resize(event: PointerEvent<HTMLDivElement>) {
    const drag = drag_ref.current;
    if (!drag) return;
    on_height_change(drag.height + event.clientY - drag.pointer_y);
  }

  function finish_resize(event: PointerEvent<HTMLDivElement>) {
    if (!drag_ref.current) return;
    drag_ref.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function resize_with_keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const direction = event.key === "ArrowUp" ? -1 : 1;
    on_height_change(height + direction * TIMELINE_ROW_KEYBOARD_RESIZE_STEP);
  }

  return (
    <div
      className="media_timeline_track_resize_handle"
      role="separator"
      tabIndex={0}
      aria-label={`调整${name}轨道高度`}
      aria-orientation="horizontal"
      aria-valuemin={TIMELINE_MINIMUM_ROW_HEIGHT}
      aria-valuemax={TIMELINE_MAXIMUM_ROW_HEIGHT}
      aria-valuenow={height}
      title="上下拖动调整高度，双击恢复默认"
      onDoubleClick={on_height_reset}
      onKeyDown={resize_with_keyboard}
      onPointerDown={start_resize}
      onPointerMove={continue_resize}
      onPointerUp={finish_resize}
      onPointerCancel={finish_resize}
    />
  );
}

type MediaTimelineEditorHandlers = {
  add_marker: (row_id: string, time: number) => void;
  handle_scroll: (position: { scrollLeft: number; scrollTop: number }) => void;
  open_action_editor: (
    action: TimelineAction,
    pointer_position: TimelinePointerPosition,
  ) => void;
  persist_marker_bounds: (
    action: TimelineAction,
    start_seconds: number,
    end_seconds: number,
    interaction: "move" | "resize",
  ) => void;
  prepare_action_context_menu: (
    event: MouseEvent<HTMLElement>,
    action: TimelineAction,
  ) => void;
  prepare_row_context_menu: (row_id: string, time: number) => void;
  seek: (time: number) => void;
  select_action: (action: TimelineAction, toggle_selection: boolean) => void;
};

type MediaTimelineEditorCanvasProps = {
  editor_data: TimelineEditor["editorData"];
  handlers_ref: RefObject<MediaTimelineEditorHandlers>;
  lod: TimelineLod;
  scale_count: number;
  timeline_ref: RefObject<TimelineState | null>;
  zoom_pixels_per_second: number;
};

// 播放时间变化只移动播放头；编辑器仅在数据或视口几何变化时重渲染。
const MediaTimelineEditorCanvas = memo(function MediaTimelineEditorCanvas({
  editor_data,
  handlers_ref,
  lod,
  scale_count,
  timeline_ref,
  zoom_pixels_per_second,
}: MediaTimelineEditorCanvasProps) {
  return (
    <Timeline
      ref={timeline_ref}
      editorData={editor_data}
      effects={EMPTY_TIMELINE_EFFECTS}
      scale={TIMELINE_SCALE_SECONDS}
      scaleWidth={zoom_pixels_per_second}
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
          action_editor_ref={handlers_ref}
        />
      )}
      onScroll={(position) => handlers_ref.current.handle_scroll(position)}
      onChange={() => false}
      onClickTimeArea={(time) => {
        handlers_ref.current.seek(time);
        return true;
      }}
      onClickActionOnly={(event, { action }) => {
        event.stopPropagation();
        handlers_ref.current.select_action(
          action,
          event.ctrlKey || event.metaKey,
        );
      }}
      onDoubleClickAction={(event, { action }) => {
        event.stopPropagation();
        handlers_ref.current.open_action_editor(action, {
          x: event.clientX,
          y: event.clientY,
        });
      }}
      onContextMenuAction={(event, { action }) =>
        handlers_ref.current.prepare_action_context_menu(event, action)
      }
      onContextMenuRow={(_event, { row, time }) =>
        handlers_ref.current.prepare_row_context_menu(row.id, time)
      }
      onDoubleClickRow={(event, { row, time }) => {
        if (lod !== TIMELINE_LOD_VALUES.detail) return;
        event.preventDefault();
        handlers_ref.current.add_marker(row.id, time);
      }}
      onActionMoveEnd={({ action, start, end }) => {
        handlers_ref.current.persist_marker_bounds(action, start, end, "move");
      }}
      onActionResizeEnd={({ action, start, end }) => {
        handlers_ref.current.persist_marker_bounds(
          action,
          start,
          end,
          "resize",
        );
      }}
    />
  );
});

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
  evidence_range?: AgentEvidenceRange | null;
  event_analyses?: EventAnalysis[];
  selected_marker_ids?: Set<string>;
  selected_transcript_indices: number[];
  analysis_strategy: AnalysisStrategy;
  marker_error: string | null;
  on_scrub_start: (seconds: number) => void;
  on_scrub_update: (seconds: number) => void;
  on_scrub_commit: (seconds: number) => void;
  on_scrub_cancel: () => void;
  on_seek: (seconds: number) => void;
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
  on_add_agent_context?: (attachment: AgentContextAttachmentDraft) => void;
  on_delete_event_analysis?: (event_analysis_id: string) => Promise<void>;
  on_request_transcription: () => void;
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
  evidence_range = null,
  event_analyses = EMPTY_EVENT_ANALYSES,
  selected_marker_ids,
  selected_transcript_indices,
  analysis_strategy,
  marker_error,
  on_scrub_start,
  on_scrub_update,
  on_scrub_commit,
  on_scrub_cancel,
  on_seek,
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
  on_add_agent_context,
  on_delete_event_analysis,
  on_request_transcription,
}: MediaTimelineProps) {
  const [selected_marker_id, set_selected_marker_id] = useState<string | null>(
    null,
  );
  const [
    uncontrolled_selected_marker_ids,
    set_uncontrolled_selected_marker_ids,
  ] = useState<Set<string>>(() => new Set());
  const [selected_read_only_action_ids, set_selected_read_only_action_ids] =
    useState<Set<string>>(() => new Set());
  const [context_marker_id, set_context_marker_id] = useState<string | null>(
    null,
  );
  const [context_transcript_indices, set_context_transcript_indices] = useState<
    number[]
  >([]);
  const [context_track_id, set_context_track_id] = useState<string | null>(
    null,
  );
  const [context_time, set_context_time] = useState(0);
  const [interaction_revision, set_interaction_revision] = useState(0);
  const [interaction_error, set_interaction_error] = useState<string | null>(
    null,
  );
  const [selected_event_analysis_ids, set_selected_event_analysis_ids] =
    useState<string[]>([]);
  const [delete_analysis, set_delete_analysis] = useState<EventAnalysis | null>(
    null,
  );
  const [row_heights, set_row_heights] = useState<Record<string, number>>({});
  const ruler_pointer_id_ref = useRef<number | null>(null);
  const ruler_bounds_ref = useRef<{ left: number } | null>(null);
  const ruler_scrub_time_ref = useRef(0);
  const timeline_context_menu_prepared_ref = useRef(false);
  const current_time_output_ref = useRef<HTMLOutputElement>(null);
  const previous_asset_id_ref = useRef(asset_id);
  const transcript_segments = useMemo(
    () => transcript?.segments ?? [],
    [transcript],
  );
  const selected_transcript_index_set = useMemo(
    () => new Set(selected_transcript_indices),
    [selected_transcript_indices],
  );
  const focus_attachment = useMemo(
    () => focus_context_attachment(focus_selection),
    [focus_selection],
  );
  const transcript_attachment = useMemo(
    () =>
      transcript_context_attachment(
        asset_id,
        transcript,
        selected_transcript_indices,
      ),
    [asset_id, selected_transcript_indices, transcript],
  );
  const effective_selected_marker_ids =
    selected_marker_ids ?? uncontrolled_selected_marker_ids;
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
    minimum_zoom_pixels_per_second,
    playhead_ref,
    reset_editor_render_window,
    set_playhead_time,
    timeline_host_ref,
    timeline_ref,
    viewport,
    zoom_to,
  } = use_media_timeline_viewport({
    asset_id,
    bounded_time,
    duration,
    is_paused,
    playback_rate,
    read_playback_time,
  });
  const [timeline_lod, set_timeline_lod] = useState<TimelineLod>(() =>
    select_timeline_lod(viewport.zoom_pixels_per_second, null),
  );
  const [ruler_major_interval_seconds, set_ruler_major_interval_seconds] =
    useState(() =>
      select_timeline_ruler_interval(viewport.zoom_pixels_per_second, null),
    );
  useLayoutEffect(() => {
    set_ruler_major_interval_seconds((current) =>
      select_timeline_ruler_interval(viewport.zoom_pixels_per_second, current),
    );
  }, [viewport.zoom_pixels_per_second]);
  useLayoutEffect(() => {
    const next_lod = select_timeline_lod(
      viewport.zoom_pixels_per_second,
      timeline_lod,
    );
    if (next_lod === timeline_lod) return;
    if (next_lod === TIMELINE_LOD_VALUES.detail) {
      reset_editor_render_window();
    }
    set_timeline_lod(next_lod);
  }, [
    reset_editor_render_window,
    timeline_lod,
    viewport.zoom_pixels_per_second,
  ]);
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
        selected_marker_ids: effective_selected_marker_ids,
        selected_transcript_indices: selected_transcript_index_set,
        selected_read_only_action_ids,
        event_analyses,
        row_heights,
      }),
    // 第三方编辑器会修改 action；保存失败时必须用新对象覆盖其本地变更。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      analysis_strategy,
      candidate_markers,
      duration,
      event_analyses,
      interaction_revision,
      markers,
      segments,
      selected_marker_id,
      effective_selected_marker_ids,
      selected_read_only_action_ids,
      selected_transcript_index_set,
      transcript_segments,
      row_heights,
    ],
  );
  const selected_action_range = useMemo(
    () => selected_timeline_range(full_editor_data),
    [full_editor_data],
  );
  const detailed_editor_data = useMemo(
    () =>
      filter_timeline_rows_for_window(full_editor_data, editor_render_window),
    [editor_render_window, full_editor_data],
  );
  const lod_editor_data = useMemo(
    () =>
      full_editor_data.map((row) => ({
        ...row,
        actions: [],
      })),
    [full_editor_data],
  );
  const editor_data =
    timeline_lod === TIMELINE_LOD_VALUES.detail
      ? detailed_editor_data
      : lod_editor_data;
  const evidence_start_seconds = Math.min(
    Math.max(evidence_range?.start_seconds ?? 0, 0),
    duration,
  );
  const evidence_end_seconds = Math.min(
    Math.max(evidence_range?.end_seconds ?? evidence_start_seconds, 0),
    duration,
  );
  const evidence_range_style = evidence_range
    ? {
        left:
          TIMELINE_START_LEFT +
          evidence_start_seconds * viewport.zoom_pixels_per_second -
          viewport.scroll_left,
        width: Math.max(
          2,
          (evidence_end_seconds - evidence_start_seconds) *
            viewport.zoom_pixels_per_second,
        ),
      }
    : null;
  const range_start_seconds = focus_selection?.in_seconds ?? null;
  const range_end_seconds = focus_selection?.out_seconds ?? null;
  const range_selection_style =
    range_start_seconds !== null &&
    range_end_seconds !== null &&
    range_start_seconds < range_end_seconds
      ? {
          left:
            TIMELINE_START_LEFT +
            range_start_seconds * viewport.zoom_pixels_per_second -
            viewport.scroll_left,
          width:
            (range_end_seconds - range_start_seconds) *
            viewport.zoom_pixels_per_second,
        }
      : null;
  const range_start_style =
    range_start_seconds === null
      ? null
      : {
          left:
            TIMELINE_START_LEFT +
            range_start_seconds * viewport.zoom_pixels_per_second -
            viewport.scroll_left,
        };
  const range_end_style =
    range_end_seconds === null
      ? null
      : {
          left:
            TIMELINE_START_LEFT +
            range_end_seconds * viewport.zoom_pixels_per_second -
            viewport.scroll_left,
        };
  const context_marker = markers.find(
    (marker) => marker.marker_id === context_marker_id,
  );
  const timeline_error = interaction_error ?? transcript_error ?? marker_error;
  const selected_event_analyses = event_analyses.filter((analysis) =>
    selected_event_analysis_ids.includes(analysis.event_analysis_id),
  );
  const track_presentations = [
    ...TIMELINE_TRACK_PRESENTATIONS,
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
  const row_height_by_id = new Map(
    full_editor_data.map((row) => [
      row.id,
      row.rowHeight ?? default_timeline_row_height(row.id),
    ]),
  );
  const {
    announcement: marquee_announcement,
    marquee_rectangle,
    start_marquee,
  } = use_media_timeline_marquee({
    on_clear_selection: clear_timeline_selection,
    on_commit_selection: commit_marquee_selection,
  });

  useEffect(() => {
    const asset_changed = previous_asset_id_ref.current !== asset_id;
    previous_asset_id_ref.current = asset_id;
    if (!asset_changed) return;
    set_selected_marker_id(null);
    set_uncontrolled_selected_marker_ids(new Set());
    set_context_marker_id(null);
    set_context_transcript_indices([]);
    set_context_track_id(null);
    set_interaction_error(null);
    set_selected_read_only_action_ids(new Set());
    set_selected_event_analysis_ids([]);
    set_row_heights({});
    on_selected_marker_ids_change?.(new Set());
    on_selected_transcript_indices_change([]);
  }, [
    asset_id,
    on_selected_marker_ids_change,
    on_selected_transcript_indices_change,
  ]);

  useEffect(() => {
    const valid_marker_ids = new Set(markers.map((marker) => marker.marker_id));
    const next_selection = new Set(
      [...effective_selected_marker_ids].filter((marker_id) =>
        valid_marker_ids.has(marker_id),
      ),
    );
    if (!sets_equal(next_selection, effective_selected_marker_ids)) {
      set_uncontrolled_selected_marker_ids(next_selection);
      on_selected_marker_ids_change?.(next_selection);
    }
    if (
      selected_marker_id !== null &&
      !valid_marker_ids.has(selected_marker_id)
    ) {
      set_selected_marker_id(null);
    }
  }, [
    effective_selected_marker_ids,
    markers,
    on_selected_marker_ids_change,
    selected_marker_id,
  ]);

  useEffect(() => {
    const next_selection = selected_transcript_indices.filter(
      (index) => index >= 0 && index < transcript_segments.length,
    );
    if (!number_arrays_equal(next_selection, selected_transcript_indices)) {
      on_selected_transcript_indices_change(next_selection);
    }
  }, [
    on_selected_transcript_indices_change,
    selected_transcript_indices,
    transcript_segments.length,
  ]);

  useEffect(() => {
    const valid_action_ids = new Set(
      full_editor_data.flatMap((row) =>
        (row.actions as MediaTimelineAction[])
          .filter(
            (action) =>
              action.data.kind !== "marker" &&
              action.data.kind !== "transcript",
          )
          .map((action) => action.id),
      ),
    );
    set_selected_read_only_action_ids((current) => {
      const next_selection = new Set(
        [...current].filter((action_id) => valid_action_ids.has(action_id)),
      );
      return sets_equal(next_selection, current) ? current : next_selection;
    });
  }, [full_editor_data]);

  const add_marker_and_select = useCallback(
    async (
      start_seconds: number,
      end_seconds: number | null = null,
    ): Promise<MediaMarker | undefined> => {
      try {
        const marker = await on_add_marker(
          normalize_marker_time(start_seconds),
          end_seconds === null ? null : normalize_marker_time(end_seconds),
        );
        if (marker) {
          set_selected_marker_id(marker.marker_id);
          const next_selection = new Set([marker.marker_id]);
          set_uncontrolled_selected_marker_ids(next_selection);
          set_selected_read_only_action_ids(new Set());
          on_selected_marker_ids_change?.(next_selection);
          on_selected_transcript_indices_change([]);
        }
        return marker;
      } catch {
        set_interaction_error("标记添加失败，请稍后重试");
        return undefined;
      }
    },
    [
      on_add_marker,
      on_selected_marker_ids_change,
      on_selected_transcript_indices_change,
    ],
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
        if (event.key === "[" || event.code === "BracketLeft") {
          event.preventDefault();
          on_set_focus_in?.(
            selected_action_range?.start_seconds ?? bounded_time,
          );
          return;
        }
        if (event.key === "]" || event.code === "BracketRight") {
          event.preventDefault();
          on_set_focus_out?.(
            selected_action_range?.end_seconds ?? bounded_time,
          );
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
    selected_action_range,
    selected_marker_id,
  ]);

  function clear_timeline_selection() {
    set_selected_marker_id(null);
    set_uncontrolled_selected_marker_ids(new Set());
    set_selected_read_only_action_ids(new Set());
    set_selected_event_analysis_ids([]);
    set_context_marker_id(null);
    set_context_transcript_indices([]);
    set_context_track_id(null);
    on_selected_marker_ids_change?.(new Set());
    on_selected_transcript_indices_change([]);
  }

  function commit_marquee_selection(
    rectangle: TimelineMarqueeRectangle,
    toggle_selection: boolean,
  ): number {
    const actions = hit_test_timeline_marquee({
      rectangle,
      rows: editor_data,
      viewport,
    });
    const hit_marker_ids = new Set<string>();
    const hit_transcript_indices = new Set<number>();
    const hit_read_only_action_ids = new Set<string>();
    for (const action of actions) {
      if (action.data.kind === "marker" && action.data.source_id) {
        hit_marker_ids.add(action.data.source_id);
      } else if (
        action.data.kind === "transcript" &&
        action.data.source_index !== undefined
      ) {
        hit_transcript_indices.add(action.data.source_index);
      } else {
        hit_read_only_action_ids.add(action.id);
      }
    }

    const next_marker_ids = toggle_selection
      ? toggle_set_members(effective_selected_marker_ids, hit_marker_ids)
      : hit_marker_ids;
    const next_transcript_indices = toggle_selection
      ? toggle_number_members(
          selected_transcript_indices,
          hit_transcript_indices,
        )
      : [...hit_transcript_indices].sort((left, right) => left - right);
    const next_read_only_action_ids = toggle_selection
      ? toggle_set_members(
          selected_read_only_action_ids,
          hit_read_only_action_ids,
        )
      : hit_read_only_action_ids;

    set_selected_marker_id(
      next_marker_ids.size === 1
        ? (next_marker_ids.values().next().value ?? null)
        : null,
    );
    set_uncontrolled_selected_marker_ids(next_marker_ids);
    set_selected_read_only_action_ids(next_read_only_action_ids);
    set_selected_event_analysis_ids([]);
    set_context_marker_id(null);
    set_context_transcript_indices([]);
    set_context_track_id(null);
    on_selected_marker_ids_change?.(next_marker_ids);
    on_selected_transcript_indices_change(next_transcript_indices);
    return actions.length;
  }

  function select_action(action: TimelineAction, toggle_selection = false) {
    const media_action = action as MediaTimelineAction;
    const { data } = media_action;
    set_interaction_error(null);
    if (data.kind === "marker" && data.source_id) {
      const next_selection = toggle_selection
        ? toggle_marker_selection(effective_selected_marker_ids, data.source_id)
        : new Set([data.source_id]);
      set_selected_marker_id(
        next_selection.has(data.source_id) ? data.source_id : null,
      );
      set_uncontrolled_selected_marker_ids(next_selection);
      set_selected_read_only_action_ids(new Set());
      set_selected_event_analysis_ids([]);
      on_selected_marker_ids_change?.(next_selection);
      on_selected_transcript_indices_change([]);
      on_seek(data.marker_anchor_seconds ?? media_action.start);
      cancel_transcript_edit();
      return;
    }
    if (data.kind === "event_analysis" && data.event_analysis_ids) {
      const next_selection = toggle_selection
        ? toggle_set_members(
            selected_read_only_action_ids,
            new Set([media_action.id]),
          )
        : new Set([media_action.id]);
      const is_selected = next_selection.has(media_action.id);
      set_selected_read_only_action_ids(next_selection);
      set_selected_event_analysis_ids(
        is_selected ? data.event_analysis_ids : [],
      );
      set_selected_marker_id(null);
      set_uncontrolled_selected_marker_ids(new Set());
      on_selected_marker_ids_change?.(new Set());
      on_selected_transcript_indices_change([]);
      on_seek(media_action.start);
      return;
    }
    if (data.kind === "candidate" || data.kind === "event") {
      const next_selection = toggle_selection
        ? toggle_set_members(
            selected_read_only_action_ids,
            new Set([media_action.id]),
          )
        : new Set([media_action.id]);
      set_selected_read_only_action_ids(next_selection);
      set_selected_event_analysis_ids([]);
      set_selected_marker_id(null);
      set_uncontrolled_selected_marker_ids(new Set());
      on_selected_marker_ids_change?.(new Set());
      on_selected_transcript_indices_change([]);
      on_seek(media_action.start);
      return;
    }
    set_selected_marker_id(null);
    set_selected_read_only_action_ids(new Set());
    set_selected_event_analysis_ids([]);
    set_uncontrolled_selected_marker_ids(new Set());
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
      const next_selection = new Set([data.source_id]);
      set_uncontrolled_selected_marker_ids(next_selection);
      set_selected_read_only_action_ids(new Set());
      set_selected_event_analysis_ids([]);
      on_selected_marker_ids_change?.(next_selection);
      on_selected_transcript_indices_change([]);
      edit_marker(data.source_id, pointer_position);
      return;
    }
    if (data.kind === "transcript" && data.source_index !== undefined) {
      set_selected_marker_id(null);
      set_uncontrolled_selected_marker_ids(new Set());
      set_selected_read_only_action_ids(new Set());
      set_selected_event_analysis_ids([]);
      on_selected_marker_ids_change?.(new Set());
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
    set_context_track_id(null);
    if (data.kind === "marker" && data.source_id) {
      timeline_context_menu_prepared_ref.current = true;
      set_context_time(data.marker_anchor_seconds ?? action.start);
      set_context_marker_id(data.source_id);
      set_context_track_id(TIMELINE_TRACK_IDS.marker);
      set_selected_marker_id(data.source_id);
      const next_selection = new Set([data.source_id]);
      set_uncontrolled_selected_marker_ids(next_selection);
      set_selected_read_only_action_ids(new Set());
      set_selected_event_analysis_ids([]);
      on_selected_marker_ids_change?.(next_selection);
      on_selected_transcript_indices_change([]);
      on_seek(data.marker_anchor_seconds ?? action.start);
      return;
    }
    if (data.kind === "transcript" && data.source_index !== undefined) {
      timeline_context_menu_prepared_ref.current = true;
      set_context_time(action.start);
      set_context_track_id(TIMELINE_TRACK_IDS.transcript);
      const context_selection = selected_transcript_index_set.has(
        data.source_index,
      )
        ? selected_transcript_indices
        : [data.source_index];
      set_context_transcript_indices(context_selection);
      set_selected_marker_id(null);
      set_uncontrolled_selected_marker_ids(new Set());
      set_selected_read_only_action_ids(new Set());
      set_selected_event_analysis_ids([]);
      on_selected_marker_ids_change?.(new Set());
      on_selected_transcript_indices_change(context_selection);
      on_seek(action.start);
      return;
    }
    event.preventDefault();
  }

  function prepare_row_context_menu(row_id: string, time: number) {
    if (timeline_context_menu_prepared_ref.current) return;
    timeline_context_menu_prepared_ref.current = true;
    set_context_marker_id(null);
    set_context_transcript_indices([]);
    set_context_track_id(row_id);
    set_context_time(Math.min(Math.max(time, 0), duration));
  }

  function prepare_timeline_context_menu(event: MouseEvent<HTMLDivElement>) {
    if (timeline_context_menu_prepared_ref.current) {
      timeline_context_menu_prepared_ref.current = false;
      return;
    }
    set_context_marker_id(null);
    set_context_transcript_indices([]);
    set_context_track_id(null);
    if (event.clientX === 0 && event.clientY === 0) {
      set_context_time(bounded_time);
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointer_x = event.clientX - bounds.left;
    const time =
      (viewport.scroll_left + pointer_x - TIMELINE_START_LEFT) /
      viewport.zoom_pixels_per_second;
    set_context_time(Math.min(Math.max(time, 0), duration));
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
    next_start = normalize_marker_time(
      Math.min(Math.max(next_start, 0), duration),
    );
    if (next_end !== null) {
      next_end = normalize_marker_time(
        Math.min(Math.max(next_end, 0), duration),
      );
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

  function set_timeline_row_height(row_id: string, height: number) {
    const bounded_height = clamp_timeline_row_height(height);
    set_row_heights((current) =>
      current[row_id] === bounded_height
        ? current
        : { ...current, [row_id]: bounded_height },
    );
  }

  function reset_timeline_row_height(row_id: string) {
    set_row_heights((current) => {
      if (current[row_id] === undefined) return current;
      const next = { ...current };
      delete next[row_id];
      return next;
    });
  }

  const editor_handlers_ref = useRef<MediaTimelineEditorHandlers>({
    add_marker: () => undefined,
    handle_scroll: () => undefined,
    open_action_editor: () => undefined,
    persist_marker_bounds: () => undefined,
    prepare_action_context_menu: () => undefined,
    prepare_row_context_menu: () => undefined,
    seek: () => undefined,
    select_action: () => undefined,
  });
  useLayoutEffect(() => {
    editor_handlers_ref.current = {
      add_marker: (row_id, time) => {
        if (row_id !== TIMELINE_TRACK_IDS.marker) return;
        void add_marker_and_select(Math.min(Math.max(time, 0), duration));
      },
      handle_scroll: handle_timeline_scroll,
      open_action_editor,
      persist_marker_bounds: (action, start, end, interaction) => {
        void persist_marker_bounds(action, start, end, interaction);
      },
      prepare_action_context_menu,
      prepare_row_context_menu,
      seek: on_seek_bounded,
      select_action,
    };
  });

  return (
    <section className="media_timeline" aria-label="剪辑时间轴">
      <MediaTimelineToolbar
        current_time={bounded_time}
        current_time_output_ref={current_time_output_ref}
        duration={duration}
        minimum_zoom_pixels_per_second={minimum_zoom_pixels_per_second}
        zoom_pixels_per_second={viewport.zoom_pixels_per_second}
        on_zoom_change={zoom_to}
        context_sources={
          on_add_agent_context ? (
            <>
              {transcript_attachment ? (
                <AgentContextSource
                  attachment={transcript_attachment}
                  on_add={on_add_agent_context}
                  compact
                />
              ) : null}
              {focus_attachment ? (
                <AgentContextSource
                  attachment={focus_attachment}
                  on_add={on_add_agent_context}
                  compact
                />
              ) : null}
            </>
          ) : null
        }
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
          <div className="media_timeline_track_labels_viewport">
            <div
              className="media_timeline_track_labels_body"
              style={{
                transform: `translate3d(0, -${viewport.scroll_top}px, 0)`,
              }}
            >
              {track_presentations.map((track) => {
                const TrackIcon = track.icon;
                const row_height =
                  row_height_by_id.get(track.id) ??
                  default_timeline_row_height(track.id);
                const track_state =
                  timeline_lod === TIMELINE_LOD_VALUES.detail
                    ? track.state
                    : timeline_lod_label(timeline_lod);
                return (
                  <div
                    key={track.id}
                    className="media_timeline_track_label"
                    style={{ height: row_height, flexBasis: row_height }}
                    aria-label={`${track.name}，${track_state}`}
                  >
                    <TrackIcon aria-hidden="true" />
                    <span>{track.name}</span>
                    <small>{track_state}</small>
                    {track.state === "只读" &&
                    timeline_lod === TIMELINE_LOD_VALUES.detail ? (
                      <LockKeyhole aria-hidden="true" />
                    ) : null}
                    <TimelineTrackResizeHandle
                      height={row_height}
                      name={track.name}
                      on_height_change={(height) =>
                        set_timeline_row_height(track.id, height)
                      }
                      on_height_reset={() =>
                        reset_timeline_row_height(track.id)
                      }
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </aside>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              ref={timeline_host_ref}
              className="media_timeline_canvas"
              data-lod={timeline_lod}
              onPointerDownCapture={
                timeline_lod === TIMELINE_LOD_VALUES.detail
                  ? start_marquee
                  : undefined
              }
              onContextMenu={prepare_timeline_context_menu}
              aria-label="时间线画布；Ctrl+M 添加标记，方括号设置范围，右键转写轨道可转录，Shift+F10 打开菜单"
              aria-description={timeline_lod_accessible_description(
                timeline_lod,
              )}
            >
              <TimelineRulerCanvas
                canvas_width={canvas_width}
                duration_seconds={duration}
                major_interval_seconds={ruler_major_interval_seconds}
                scroll_left={viewport.scroll_left}
                start_left={TIMELINE_START_LEFT}
                zoom_pixels_per_second={viewport.zoom_pixels_per_second}
              />
              <TimelineGrid
                canvas_width={canvas_width}
                duration_seconds={duration}
                major_interval_seconds={ruler_major_interval_seconds}
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
                onLostPointerCapture={cancel_ruler_scrub}
              />
              <div
                ref={playhead_ref}
                className="media_timeline_playhead"
                data-visible="false"
                aria-hidden="true"
              />
              <MediaTimelineEditorCanvas
                editor_data={editor_data}
                handlers_ref={editor_handlers_ref}
                lod={timeline_lod}
                scale_count={scale_count}
                timeline_ref={timeline_ref}
                zoom_pixels_per_second={viewport.zoom_pixels_per_second}
              />
              {range_selection_style ? (
                <div
                  className="media_timeline_range_selection"
                  style={range_selection_style}
                  aria-hidden="true"
                />
              ) : null}
              {range_start_style ? (
                <div
                  className="media_timeline_range_endpoint"
                  data-edge="start"
                  style={range_start_style}
                  aria-hidden="true"
                />
              ) : null}
              {range_end_style ? (
                <div
                  className="media_timeline_range_endpoint"
                  data-edge="end"
                  style={range_end_style}
                  aria-hidden="true"
                />
              ) : null}
              {timeline_lod !== TIMELINE_LOD_VALUES.detail ? (
                <MediaTimelineLodCanvas
                  canvas_width={canvas_width}
                  lod={timeline_lod}
                  rows={full_editor_data}
                  scroll_left={viewport.scroll_left}
                  scroll_top={viewport.scroll_top}
                  start_left={TIMELINE_START_LEFT}
                  zoom_pixels_per_second={viewport.zoom_pixels_per_second}
                />
              ) : null}
              {evidence_range_style && evidence_range ? (
                <div
                  className="media_timeline_evidence_range"
                  style={evidence_range_style}
                  data-evidence-id={evidence_range.evidence_id}
                  aria-hidden="true"
                />
              ) : null}
              {marquee_rectangle &&
              timeline_lod === TIMELINE_LOD_VALUES.detail ? (
                <div
                  className="media_timeline_marquee"
                  style={{
                    left: marquee_rectangle.left,
                    top: marquee_rectangle.top,
                    width: marquee_rectangle.width,
                    height: marquee_rectangle.height,
                  }}
                  aria-hidden="true"
                />
              ) : null}
              <output className="sr_only" aria-live="polite">
                {marquee_announcement}
              </output>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="min-w-48">
            {context_marker ? (
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
            ) : context_track_id === TIMELINE_TRACK_IDS.transcript ? (
              <ContextMenuGroup>
                <ContextMenuLabel>
                  {context_transcript_indices.length === 0
                    ? "转写轨道"
                    : context_transcript_indices.length === 1
                      ? "字幕"
                      : `已选择 ${context_transcript_indices.length} 条字幕`}
                </ContextMenuLabel>
                <ContextMenuItem onSelect={on_request_transcription}>
                  <Captions aria-hidden="true" />
                  {transcript ? "重新转录" : "生成转录"}
                </ContextMenuItem>
                {context_transcript_indices.length > 0 ? (
                  <ContextMenuItem
                    onSelect={() =>
                      on_request_transcript_correction(
                        context_transcript_indices,
                      )
                    }
                  >
                    快速修正字幕
                  </ContextMenuItem>
                ) : null}
                {context_transcript_indices.length > 0 &&
                transcript_attachment &&
                on_add_agent_context ? (
                  <ContextMenuItem
                    onSelect={() =>
                      on_add_agent_context(
                        renew_context_attachment_draft(transcript_attachment),
                      )
                    }
                  >
                    <Bot aria-hidden="true" />
                    添加给 AI
                  </ContextMenuItem>
                ) : null}
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
            ) : null}
            {context_marker ||
            context_track_id === TIMELINE_TRACK_IDS.transcript ? (
              <ContextMenuSeparator />
            ) : null}
            <ContextMenuGroup>
              <ContextMenuLabel>时间线操作</ContextMenuLabel>
              <ContextMenuItem
                onSelect={() => void add_marker_and_select(context_time)}
              >
                <Flag aria-hidden="true" />
                添加标记
                <ContextMenuShortcut>Ctrl+M</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!on_set_focus_in}
                onSelect={() =>
                  on_set_focus_in?.(
                    selected_action_range?.start_seconds ?? context_time,
                  )
                }
              >
                设置范围起点
                <ContextMenuShortcut>[</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!on_set_focus_out}
                onSelect={() =>
                  on_set_focus_out?.(
                    selected_action_range?.end_seconds ?? context_time,
                  )
                }
              >
                设置范围终点
                <ContextMenuShortcut>]</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem
                disabled={focus_selection === null || !on_clear_focus}
                onSelect={() => on_clear_focus?.()}
              >
                清除范围
              </ContextMenuItem>
            </ContextMenuGroup>
          </ContextMenuContent>
        </ContextMenu>
      </div>

      {timeline_error ? (
        <Alert className="media_timeline_error" variant="destructive">
          <AlertDescription>{timeline_error}</AlertDescription>
        </Alert>
      ) : null}
      {evidence_range ? (
        <output className="sr_only" aria-live="polite">
          已高亮答案证据 {format_time(evidence_range.start_seconds)} 至
          {format_time(evidence_range.end_seconds)}
        </output>
      ) : null}
      {focus_selection ? (
        <output className="sr_only" aria-live="polite">
          {range_start_seconds === null
            ? "尚未设置范围起点"
            : `范围起点 ${format_time(range_start_seconds)}`}
          ；
          {range_end_seconds === null
            ? "尚未设置范围终点"
            : `范围终点 ${format_time(range_end_seconds)}`}
        </output>
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

  function on_scrub_start_bounded(seconds: number) {
    on_scrub_start(Math.min(Math.max(seconds, 0), duration));
  }

  function on_scrub_update_bounded(seconds: number) {
    on_scrub_update(Math.min(Math.max(seconds, 0), duration));
  }

  function on_scrub_commit_bounded(seconds: number) {
    on_scrub_commit(Math.min(Math.max(seconds, 0), duration));
  }

  function ruler_time_from_pointer(client_x: number) {
    const bounds = ruler_bounds_ref.current;
    if (!bounds) return ruler_scrub_time_ref.current;
    const pointer_x = client_x - bounds.left;
    return Math.min(
      Math.max(
        (viewport.scroll_left + pointer_x - TIMELINE_START_LEFT) /
          viewport.zoom_pixels_per_second,
        0,
      ),
      duration,
    );
  }

  function update_ruler_scrub_feedback(ruler: HTMLDivElement, time: number) {
    ruler.setAttribute("aria-valuenow", String(time));
    ruler.setAttribute("aria-valuetext", format_ruler_accessible_time(time));
    const output = current_time_output_ref.current;
    if (output) {
      output.textContent = `${format_time(time)} / ${format_time(duration)}`;
    }
  }

  function start_ruler_scrub(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || ruler_pointer_id_ref.current !== null) return;
    event.preventDefault();
    ruler_pointer_id_ref.current = event.pointerId;
    const bounds = event.currentTarget.getBoundingClientRect();
    ruler_bounds_ref.current = { left: bounds.left };
    event.currentTarget.setPointerCapture(event.pointerId);
    const time = ruler_time_from_pointer(event.clientX);
    ruler_scrub_time_ref.current = time;
    set_playhead_time(time, { keep_visible: true });
    update_ruler_scrub_feedback(event.currentTarget, time);
    on_scrub_start_bounded(time);
  }

  function continue_ruler_scrub(event: PointerEvent<HTMLDivElement>) {
    if (ruler_pointer_id_ref.current !== event.pointerId) return;
    const time = ruler_time_from_pointer(event.clientX);
    ruler_scrub_time_ref.current = time;
    set_playhead_time(time, { keep_visible: true });
    update_ruler_scrub_feedback(event.currentTarget, time);
    on_scrub_update_bounded(time);
  }

  function finish_ruler_scrub(event: PointerEvent<HTMLDivElement>) {
    if (ruler_pointer_id_ref.current !== event.pointerId) return;
    const time = ruler_time_from_pointer(event.clientX);
    ruler_pointer_id_ref.current = null;
    ruler_bounds_ref.current = null;
    ruler_scrub_time_ref.current = time;
    event.currentTarget.releasePointerCapture(event.pointerId);
    set_playhead_time(time, {
      follow_viewport: true,
      keep_visible: true,
    });
    update_ruler_scrub_feedback(event.currentTarget, time);
    on_scrub_commit_bounded(time);
  }

  function cancel_ruler_scrub(event: PointerEvent<HTMLDivElement>) {
    if (ruler_pointer_id_ref.current !== event.pointerId) return;
    ruler_pointer_id_ref.current = null;
    ruler_bounds_ref.current = null;
    const presented_time = Math.min(
      Math.max(read_playback_time?.() ?? current_time, 0),
      duration,
    );
    ruler_scrub_time_ref.current = presented_time;
    set_playhead_time(presented_time, { follow_viewport: true });
    update_ruler_scrub_feedback(event.currentTarget, presented_time);
    on_scrub_cancel();
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
  return `${normalize_marker_time(seconds).toFixed(3)} 秒`;
}

function timeline_lod_accessible_description(lod: TimelineLod): string {
  if (lod === TIMELINE_LOD_VALUES.overview) {
    return "当前为概览层级，片段已聚合为区块；放大时间线后可选择和编辑单个片段";
  }
  if (lod === TIMELINE_LOD_VALUES.compact) {
    return "当前为简化层级，仅显示无文字片段；继续放大后可选择和编辑单个片段";
  }
  return "当前为详细层级，可选择、移动和编辑时间线片段";
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

function toggle_set_members<T>(
  current: ReadonlySet<T>,
  toggled: ReadonlySet<T>,
): Set<T> {
  const next = new Set(current);
  for (const value of toggled) {
    if (next.has(value)) next.delete(value);
    else next.add(value);
  }
  return next;
}

function toggle_number_members(
  current: number[],
  toggled: ReadonlySet<number>,
): number[] {
  return [...toggle_set_members(new Set(current), toggled)].sort(
    (left, right) => left - right,
  );
}

function sets_equal<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

function number_arrays_equal(left: number[], right: number[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
