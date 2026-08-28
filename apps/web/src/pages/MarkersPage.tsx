import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { useNavigate } from "react-router-dom";

import { use_asset_catalog } from "@/app/asset_catalog";
import { use_task_manager } from "@/app/task_manager";
import { marker_asset_path } from "@/app/workspace_routes";
import { use_asset_analysis } from "@/features/analysis/use_asset_analysis";
import {
  use_ai_models,
  use_analysis_resources,
} from "@/features/analysis/use_analysis_resources";
import { use_compact_markers_layout } from "@/features/markers/use_compact_markers_layout";
import { use_markers_page_settings } from "@/features/markers/use_markers_page_settings";
import { MarkerAgentPanel } from "@/features/markers/MarkerAgentPanel";
import { MarkerLeftPanel } from "@/features/markers/MarkerLeftPanel";
import { type PlayerHandle } from "@/features/player/Player";
import { use_asset_markers } from "@/features/player/use_asset_markers";
import { AnalysisToolPanel } from "@/features/workbench/AnalysisToolPanel";
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
  create_event_analysis_job,
  delete_event_analysis,
  get_event_analysis_job,
  get_focus_selection,
  list_event_analyses,
  resolve_analysis_proposal,
  update_focus_selection,
} from "@/shared/api";
import type {
  AnalysisDepth,
  AnalysisJob,
  AnalysisStrategy,
  EventAnalysis,
  EventAnalysisJob,
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
const EVENT_ANALYSIS_POLL_MS = 500;

export function MarkersPage() {
  const navigate = useNavigate();
  const { selected_asset, selected_asset_id } = use_asset_catalog();
  const { start_analysis, start_transcription, is_operation_running } =
    use_task_manager();
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
    analysis_strategies,
    error: analysis_resources_error,
  } = use_analysis_resources();
  const [current_time, set_current_time] = useState(0);
  const [is_paused, set_is_paused] = useState(true);
  const [playback_rate, set_playback_rate] = useState(1);
  const [selected_transcript_indices, set_selected_transcript_indices] =
    useState<number[]>([]);
  const [page_error, set_page_error] = useState<string | null>(null);
  const [analysis_proposal, set_analysis_proposal] =
    useState<AnalysisJob | null>(null);
  const [focus_selection, set_focus_selection] =
    useState<FocusSelection | null>(null);
  const [event_analyses, set_event_analyses] = useState<EventAnalysis[]>([]);
  const [event_analysis_job, set_event_analysis_job] =
    useState<EventAnalysisJob | null>(null);
  const [selected_marker_ids, set_selected_marker_ids] = useState<Set<string>>(
    new Set(),
  );
  const [candidate_markers, set_candidate_markers] = useState<MediaMarker[]>(
    [],
  );
  const [analysis_strategy, set_analysis_strategy] = useState<AnalysisStrategy>(
    () => structuredClone(DEFAULT_ANALYSIS_STRATEGY),
  );
  const [transcription_model_overrides, set_transcription_model_overrides] =
    useState<Record<string, (typeof loaded_transcription_models)[number]>>({});
  const [is_panel_size_transitioning, set_is_panel_size_transitioning] =
    useState(false);
  const panel_transition_timeout_ref = useRef<number | null>(null);
  const player_ref = useRef<PlayerHandle>(null);
  const left_panel_ref = useRef<PanelImperativeHandle>(null);
  const tool_panel_ref = useRef<PanelImperativeHandle>(null);
  const mounted_ref = useRef(true);
  const active_asset_id_ref = useRef<string | null>(selected_asset_id);
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
    active_asset_id_ref.current = selected_asset_id;
    set_current_time(0);
    set_is_paused(true);
    set_playback_rate(1);
    set_selected_transcript_indices([]);
    set_candidate_markers([]);
    set_analysis_proposal(null);
    set_focus_selection(null);
    set_event_analyses([]);
    set_event_analysis_job(null);
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

  async function run_analysis(
    ai_model_id: string | null,
    strategy: AnalysisStrategy,
  ) {
    if (!selected_asset_id) return;
    set_page_error(null);
    try {
      const job = await start_analysis(
        selected_asset_id,
        ai_model_id,
        strategy,
      );
      if (job.stage === "waiting_for_approval") set_analysis_proposal(job);
      if (mounted_ref.current) await reload_analysis();
    } catch (error) {
      if (mounted_ref.current && !is_abort_error(error))
        set_page_error(error_message(error));
    }
  }

  async function run_event_analysis(request: {
    marker_ids: string[];
    use_focus_selection: boolean;
    preset_id: string;
    preset_version: number;
    depth: AnalysisDepth;
    user_input: string | null;
    ai_model_id: string;
  }) {
    if (!selected_asset_id) return;
    const asset_id = selected_asset_id;
    set_page_error(null);
    try {
      let job = await create_event_analysis_job(asset_id, request);
      set_event_analysis_job(job);
      while (job.stage === "pending" || job.stage === "running") {
        await new Promise((resolve) =>
          window.setTimeout(resolve, EVENT_ANALYSIS_POLL_MS),
        );
        job = await get_event_analysis_job(job.job_id);
        if (!mounted_ref.current || active_asset_id_ref.current !== asset_id)
          return;
        set_event_analysis_job(job);
      }
      if (job.stage === "failed") {
        throw new Error(job.error_message ?? "事件分析失败");
      }
      set_event_analyses(await list_event_analyses(asset_id));
    } catch (error) {
      if (mounted_ref.current && !is_abort_error(error)) {
        set_page_error(error_message(error));
      }
    }
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

  async function resolve_analysis(action: "approve" | "reject") {
    if (!analysis_proposal) return;
    set_page_error(null);
    try {
      await resolve_analysis_proposal(analysis_proposal.job_id, action);
      set_analysis_proposal(null);
      if (mounted_ref.current) await reload_analysis();
    } catch (error) {
      if (mounted_ref.current && !is_abort_error(error)) {
        set_page_error(error_message(error));
      }
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

  function set_tool_panel_collapsed(collapsed: boolean) {
    animate_panel_size_change();
    if (collapsed) tool_panel_ref.current?.collapse();
    else tool_panel_ref.current?.resize(`${settings.tool_panel_size_percent}%`);
    update_settings({ tool_panel_collapsed: collapsed });
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
    const tool_panel_collapsed = tool_panel_ref.current?.isCollapsed() ?? false;
    const patch: Parameters<typeof update_settings>[0] = {
      left_panel_collapsed,
      tool_panel_collapsed,
    };
    if (!left_panel_collapsed && layout["left-panel"] !== undefined) {
      patch.left_panel_size_percent = layout["left-panel"];
    }
    if (!tool_panel_collapsed && layout["tool-panel"] !== undefined) {
      patch.tool_panel_size_percent = layout["tool-panel"];
    }
    update_settings(patch);
  }

  const is_transcribing = selected_asset_id
    ? is_operation_running(selected_asset_id, "transcription")
    : false;
  const is_analyzing = selected_asset_id
    ? is_operation_running(selected_asset_id, "analysis")
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
  const tool_panel = (
    <AnalysisToolPanel
      asset={selected_asset}
      markers={markers}
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
      is_analyzing={is_analyzing}
      ai_models={ai_models}
      analysis_strategies={analysis_strategies}
      analysis_strategy={analysis_strategy}
      set_analysis_strategy={set_analysis_strategy}
      focus_selection={focus_selection}
      event_analysis_job={event_analysis_job}
      selected_marker_ids={selected_marker_ids}
      set_selected_marker_ids={set_selected_marker_ids}
      on_start_analysis={(ai_model_id, strategy) =>
        void run_analysis(ai_model_id, strategy)
      }
      on_start_event_analysis={(request) => void run_event_analysis(request)}
      analysis_proposal={analysis_proposal}
      on_resolve_analysis={(action) => void resolve_analysis(action)}
      selected_transcript_indices={selected_transcript_indices}
      on_transcript_changed={() => void reload_analysis()}
      open_sections={settings.open_tool_sections}
      on_open_sections_change={(open_tool_sections) =>
        update_settings({ open_tool_sections })
      }
      collapsed={!is_compact_layout && settings.tool_panel_collapsed}
      on_collapsed_change={
        is_compact_layout ? undefined : set_tool_panel_collapsed
      }
    />
  );

  const error =
    page_error ??
    ai_models_error ??
    analysis_resources_error ??
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
          <div className="flex min-h-full flex-col [&>[data-slot=analysis-tools]]:min-h-72 [&>[data-slot=analysis-tools]]:shrink-0 [&>[data-slot=analysis-tools]]:border-t [&>[data-slot=marker-left-panel]]:h-[32rem] [&>[data-slot=marker-left-panel]]:shrink-0 [&>[data-slot=marker-left-panel]]:border-b [&>[data-slot=video-workspace]]:min-h-120 [&>[data-slot=video-workspace]]:shrink-0 max-[600px]:[&>[data-slot=video-workspace]]:min-h-96">
            {left_panel}
            {video_workspace}
            {tool_panel}
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
            <ResizableHandle
              className="hover:bg-primary"
              withHandle
              aria-label="调整工具面板宽度"
            />
            <ResizablePanel
              id="tool-panel"
              panelRef={tool_panel_ref}
              defaultSize={
                settings.tool_panel_collapsed
                  ? `${PANEL_RAIL_WIDTH_PX}px`
                  : `${settings.tool_panel_size_percent}%`
              }
              minSize="14%"
              maxSize="32%"
              collapsedSize={`${PANEL_RAIL_WIDTH_PX}px`}
              collapsible
            >
              {tool_panel}
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
        />
      </Suspense>
      {error ? <FloatingError message={error} /> : null}
    </>
  );
}
