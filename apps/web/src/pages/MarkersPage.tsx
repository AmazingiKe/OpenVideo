import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { useNavigate } from "react-router-dom";

import { use_asset_catalog } from "@/app/asset_catalog";
import { use_task_manager } from "@/app/task_manager";
import { marker_asset_path } from "@/app/workspace_routes";
import { use_asset_analysis } from "@/features/analysis/use_asset_analysis";
import {
  use_ai_models,
  use_transcription_resources,
} from "@/features/workbench/use_processing_resources";
import { use_compact_markers_layout } from "@/features/markers/use_compact_markers_layout";
import { use_markers_page_settings } from "@/features/markers/use_markers_page_settings";
import { MarkerAgentPanel } from "@/features/markers/MarkerAgentPanel";
import { MarkerLeftPanel } from "@/features/markers/MarkerLeftPanel";
import { type PlayerHandle } from "@/features/player/Player";
import { use_asset_markers } from "@/features/player/use_asset_markers";
import {
  TranscriptionToolbarTools,
  type TranscriptCorrectionScope,
} from "@/features/workbench/TranscriptionToolbarTools";
import { PANEL_RAIL_WIDTH_PX } from "@/features/workbench/CollapsiblePanelRail";
import { VideoWorkspace } from "@/features/workbench/VideoWorkspace";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Spinner } from "@/components/ui/spinner";
import { FloatingError } from "@/components/FloatingError";
import { cn } from "@/lib/utils";
import { error_message, is_abort_error } from "@/shared/errors";
import { DEFAULT_ANALYSIS_STRATEGY } from "@/shared/analysis";
import {
  clear_focus_selection,
  delete_event_analysis,
  get_focus_selection,
  list_event_analyses,
  update_focus_selection,
} from "@/shared/api";
import type {
  EventAnalysis,
  FocusSelection,
  MediaMarker,
  TranscriptionOptions,
} from "@/shared/types";

const MediaTimeline = lazy(() =>
  import("@/features/workbench/MediaTimeline").then((module) => ({
    default: module.MediaTimeline,
  })),
);

// 比样式表里 220ms 的面板过渡多留一拍，确保过渡结束前过渡类不被移除
const PANEL_TOGGLE_TRANSITION_MS = 280;

export function MarkersPage() {
  const navigate = useNavigate();
  const { selected_asset, selected_asset_id } = use_asset_catalog();
  const { start_transcription, is_transcription_running } = use_task_manager();
  const {
    segments,
    transcript,
    analysis_error,
    reload_analysis,
    save_transcript_segment,
  } = use_asset_analysis(selected_asset_id);
  const { settings, settings_error, is_ready, update_settings } =
    use_markers_page_settings();
  const { models: ai_models, error: ai_models_error } = use_ai_models();
  const {
    transcription_models: loaded_transcription_models,
    default_transcription,
    error: transcription_resources_error,
  } = use_transcription_resources();
  const [current_time, set_current_time] = useState(0);
  const [is_paused, set_is_paused] = useState(true);
  const [playback_rate, set_playback_rate] = useState(1);
  const [selected_transcript_indices, set_selected_transcript_indices] =
    useState<number[]>([]);
  const [transcript_correction_open, set_transcript_correction_open] =
    useState(false);
  const [transcript_correction_scope, set_transcript_correction_scope] =
    useState<TranscriptCorrectionScope>("all");
  const [page_error, set_page_error] = useState<string | null>(null);
  const [focus_selection, set_focus_selection] =
    useState<FocusSelection | null>(null);
  const [event_analyses, set_event_analyses] = useState<EventAnalysis[]>([]);
  const [selected_marker_ids, set_selected_marker_ids] = useState<Set<string>>(
    new Set(),
  );
  const [candidate_markers, set_candidate_markers] = useState<MediaMarker[]>(
    [],
  );
  const analysis_strategy = DEFAULT_ANALYSIS_STRATEGY;
  const [transcription_model_overrides, set_transcription_model_overrides] =
    useState<Record<string, (typeof loaded_transcription_models)[number]>>({});
  const [is_panel_size_transitioning, set_is_panel_size_transitioning] =
    useState(false);
  const panel_transition_timeout_ref = useRef<number | null>(null);
  const player_ref = useRef<PlayerHandle>(null);
  const left_panel_ref = useRef<PanelImperativeHandle>(null);
  const mounted_ref = useRef(true);
  const is_compact_layout = use_compact_markers_layout();
  const {
    markers,
    marker_error,
    add_marker,
    update_marker,
    remove_marker,
    reload_markers,
  } = use_asset_markers(selected_asset_id ?? "");
  const marker_selection_key = markers
    .map((marker) => marker.marker_id)
    .sort()
    .join("|");
  const visible_event_analyses =
    selected_marker_ids.size === 0
      ? event_analyses
      : event_analyses.filter(
          (analysis) =>
            analysis.target.source === "marker" &&
            selected_marker_ids.has(analysis.target.marker_id),
        );

  useEffect(() => {
    mounted_ref.current = true;
    return () => {
      mounted_ref.current = false;
    };
  }, []);

  useEffect(() => {
    set_current_time(0);
    set_is_paused(true);
    set_playback_rate(1);
    set_selected_transcript_indices([]);
    set_transcript_correction_open(false);
    set_transcript_correction_scope("all");
    set_candidate_markers([]);
    set_focus_selection(null);
    set_event_analyses([]);
    set_selected_marker_ids(new Set());
  }, [selected_asset_id]);

  useEffect(() => {
    const available_marker_ids = new Set(
      marker_selection_key ? marker_selection_key.split("|") : [],
    );
    set_selected_marker_ids((current) => {
      const retained = new Set(
        [...current].filter((marker_id) => available_marker_ids.has(marker_id)),
      );
      return retained.size === current.size ? current : retained;
    });
  }, [marker_selection_key, selected_asset_id]);

  useEffect(() => {
    if (!selected_asset_id) return;
    const controller = new AbortController();
    void Promise.all([
      get_focus_selection(selected_asset_id, controller.signal),
      list_event_analyses(selected_asset_id, controller.signal),
    ])
      .then(([selection, analyses]) => {
        if (!mounted_ref.current) return;
        set_focus_selection(selection);
        set_event_analyses(analyses);
      })
      .catch((error) => {
        if (!is_abort_error(error)) set_page_error(error_message(error));
      });
    return () => controller.abort();
  }, [selected_asset_id]);

  useEffect(
    () => () => {
      if (panel_transition_timeout_ref.current !== null) {
        window.clearTimeout(panel_transition_timeout_ref.current);
      }
    },
    [],
  );

  function animate_panel_size_change() {
    set_is_panel_size_transitioning(true);
    if (panel_transition_timeout_ref.current !== null) {
      window.clearTimeout(panel_transition_timeout_ref.current);
    }
    panel_transition_timeout_ref.current = window.setTimeout(() => {
      panel_transition_timeout_ref.current = null;
      set_is_panel_size_transitioning(false);
    }, PANEL_TOGGLE_TRANSITION_MS);
  }

  function seek_player(seconds: number) {
    set_current_time(seconds);
    player_ref.current?.seek_to(seconds);
  }

  function preview_player(seconds: number) {
    set_current_time(seconds);
    player_ref.current?.preview_to(seconds);
  }

  async function set_focus_endpoint(
    endpoint: "in_seconds" | "out_seconds",
    seconds: number,
  ) {
    if (!selected_asset_id) return;
    try {
      set_focus_selection(
        await update_focus_selection(selected_asset_id, {
          [endpoint]: seconds,
        }),
      );
    } catch (error) {
      set_page_error(error_message(error));
    }
  }

  async function clear_focus() {
    if (!selected_asset_id) return;
    try {
      await clear_focus_selection(selected_asset_id);
      set_focus_selection(null);
    } catch (error) {
      set_page_error(error_message(error));
    }
  }

  async function remove_event_analysis(event_analysis_id: string) {
    try {
      await delete_event_analysis(event_analysis_id);
      set_event_analyses((current) =>
        current.filter(
          (analysis) => analysis.event_analysis_id !== event_analysis_id,
        ),
      );
    } catch (error) {
      set_page_error(error_message(error));
      throw error;
    }
  }

  async function run_transcription(options: TranscriptionOptions) {
    if (!selected_asset_id) return;
    set_page_error(null);
    try {
      await start_transcription(selected_asset_id, options);
      if (mounted_ref.current) await reload_analysis();
    } catch (error) {
      if (mounted_ref.current && !is_abort_error(error))
        set_page_error(error_message(error));
    }
  }

  function set_left_panel_collapsed(collapsed: boolean) {
    animate_panel_size_change();
    if (collapsed) left_panel_ref.current?.collapse();
    else left_panel_ref.current?.resize(`${settings.left_panel_size_percent}%`);
    update_settings({ left_panel_collapsed: collapsed });
  }

  function save_desktop_layout(layout: Record<string, number>) {
    const left_panel_collapsed =
      left_panel_ref.current?.isCollapsed() ?? settings.left_panel_collapsed;
    const patch: Parameters<typeof update_settings>[0] = {
      left_panel_collapsed,
    };
    if (!left_panel_collapsed && layout["left-panel"] !== undefined) {
      patch.left_panel_size_percent = layout["left-panel"];
    }
    update_settings(patch);
  }

  function open_transcript_correction(segment_indices: number[]) {
    set_selected_transcript_indices(segment_indices);
    set_transcript_correction_scope(
      segment_indices.length > 0 ? "selection" : "all",
    );
    set_transcript_correction_open(true);
  }

  const is_transcribing = selected_asset_id
    ? is_transcription_running(selected_asset_id)
    : false;
  const transcription_models = loaded_transcription_models.map(
    (model) =>
      transcription_model_overrides[`${model.engine}:${model.model}`] ?? model,
  );
  const agent_panel = (
    <MarkerAgentPanel
      asset_id={selected_asset_id}
      models={ai_models}
      on_seek={seek_player}
      on_candidate_markers_change={set_candidate_markers}
      on_markers_changed={reload_markers}
    />
  );
  const left_panel = (
    <MarkerLeftPanel
      active_tab={settings.left_panel_tab}
      collapsed={!is_compact_layout && settings.left_panel_collapsed}
      compact={is_compact_layout}
      current_video_id={selected_asset_id}
      initial_folder_id={selected_asset ? selected_asset.folder_id : undefined}
      agent_panel={agent_panel}
      on_active_tab_change={(left_panel_tab) =>
        update_settings({ left_panel_tab })
      }
      on_collapsed_change={
        is_compact_layout ? undefined : set_left_panel_collapsed
      }
      on_open_video={(asset) => navigate(marker_asset_path(asset.asset_id))}
    />
  );
  const video_workspace = (
    <VideoWorkspace
      asset={selected_asset}
      markers={markers}
      transcript={transcript}
      player_ref={player_ref}
      is_paused={is_paused}
      playback_rate={playback_rate}
      on_time_change={set_current_time}
      on_pause_change={set_is_paused}
      on_playback_rate_change={set_playback_rate}
    />
  );
  const transcription_tools = (
    <TranscriptionToolbarTools
      asset={selected_asset}
      has_transcript={transcript !== null}
      is_transcribing={is_transcribing}
      on_start_transcription={(options) => void run_transcription(options)}
      transcription_models={transcription_models}
      default_transcription={default_transcription}
      on_transcription_model_change={(updated_model) =>
        set_transcription_model_overrides((current) => ({
          ...current,
          [`${updated_model.engine}:${updated_model.model}`]: updated_model,
        }))
      }
      ai_models={ai_models}
      selected_transcript_indices={selected_transcript_indices}
      on_transcript_changed={() => void reload_analysis()}
      correction_open={transcript_correction_open}
      correction_scope={transcript_correction_scope}
      on_correction_open_change={set_transcript_correction_open}
      on_correction_scope_change={set_transcript_correction_scope}
    />
  );

  const error =
    page_error ??
    ai_models_error ??
    transcription_resources_error ??
    settings_error ??
    analysis_error;
  return (
    <>
      <div
        className={cn(
          "min-h-0 min-w-0 overflow-hidden max-[979px]:overflow-auto",
          is_panel_size_transitioning && "panel-size-transition",
        )}
      >
        {!is_ready ? (
          <div
            className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <Spinner />
            正在恢复工作台布局
          </div>
        ) : is_compact_layout ? (
          <div className="flex min-h-full flex-col [&>[data-slot=marker-left-panel]]:h-[32rem] [&>[data-slot=marker-left-panel]]:shrink-0 [&>[data-slot=marker-left-panel]]:border-b [&>[data-slot=video-workspace]]:min-h-120 [&>[data-slot=video-workspace]]:shrink-0 max-[600px]:[&>[data-slot=video-workspace]]:min-h-96">
            {left_panel}
            {video_workspace}
          </div>
        ) : (
          <ResizablePanelGroup
            id="markers-workspace"
            orientation="horizontal"
            onLayoutChanged={(layout, metadata) => {
              if (metadata.isUserInteraction) save_desktop_layout(layout);
            }}
          >
            <ResizablePanel
              id="left-panel"
              panelRef={left_panel_ref}
              defaultSize={
                settings.left_panel_collapsed
                  ? `${PANEL_RAIL_WIDTH_PX}px`
                  : `${settings.left_panel_size_percent}%`
              }
              minSize="320px"
              maxSize="40%"
              collapsedSize={`${PANEL_RAIL_WIDTH_PX}px`}
              collapsible
              onResize={(size) => {
                const collapsed = size.inPixels <= PANEL_RAIL_WIDTH_PX + 1;
                if (collapsed !== settings.left_panel_collapsed) {
                  update_settings({ left_panel_collapsed: collapsed });
                }
              }}
            >
              {left_panel}
            </ResizablePanel>
            <ResizableHandle
              className="hover:bg-primary"
              withHandle
              aria-label="调整左侧面板宽度"
            />
            <ResizablePanel id="video-player" minSize="400px">
              {video_workspace}
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>
      <Suspense
        fallback={
          <section
            className="media_timeline flex items-center justify-center gap-2 text-sm text-muted-foreground"
            role="status"
            aria-label="剪辑时间轴"
            aria-busy="true"
          >
            <Spinner />
            正在加载时间线…
          </section>
        }
      >
        <MediaTimeline
          asset_id={selected_asset_id}
          duration_seconds={selected_asset?.duration_seconds ?? null}
          current_time={current_time}
          read_playback_time={() =>
            player_ref.current?.current_time() ?? current_time
          }
          is_paused={is_paused}
          playback_rate={playback_rate}
          transcript={transcript}
          segments={segments}
          markers={markers}
          candidate_markers={candidate_markers}
          focus_selection={focus_selection}
          event_analyses={visible_event_analyses}
          selected_marker_ids={selected_marker_ids}
          selected_transcript_indices={selected_transcript_indices}
          analysis_strategy={analysis_strategy}
          marker_error={marker_error}
          on_scrub={preview_player}
          on_seek={seek_player}
          on_toggle_playback={() => player_ref.current?.toggle_playback()}
          on_playback_rate_change={(rate) =>
            player_ref.current?.set_playback_rate(rate)
          }
          on_selected_transcript_indices_change={
            set_selected_transcript_indices
          }
          on_request_transcript_correction={open_transcript_correction}
          on_selected_marker_ids_change={set_selected_marker_ids}
          on_set_focus_in={(seconds) =>
            void set_focus_endpoint("in_seconds", seconds)
          }
          on_set_focus_out={(seconds) =>
            void set_focus_endpoint("out_seconds", seconds)
          }
          on_clear_focus={() => void clear_focus()}
          on_delete_event_analysis={remove_event_analysis}
          on_add_marker={add_marker}
          on_update_marker={update_marker}
          on_delete_marker={remove_marker}
          on_update_transcript={save_transcript_segment}
          toolbar_tools={transcription_tools}
        />
      </Suspense>
      {error ? <FloatingError message={error} /> : null}
    </>
  );
}
