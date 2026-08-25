import { useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

import { use_asset_catalog } from "@/app/asset_catalog";
import { use_task_manager } from "@/app/task_manager";
import { use_asset_analysis } from "@/features/analysis/use_asset_analysis";
import {
  use_ai_models,
  use_analysis_resources,
} from "@/features/analysis/use_analysis_resources";
import { use_compact_markers_layout } from "@/features/markers/use_compact_markers_layout";
import { use_markers_page_settings } from "@/features/markers/use_markers_page_settings";
import { MarkerAgentPanel } from "@/features/markers/MarkerAgentPanel";
import { type PlayerHandle } from "@/features/player/Player";
import { use_asset_markers } from "@/features/player/use_asset_markers";
import { AnalysisToolPanel } from "@/features/workbench/AnalysisToolPanel";
import { PANEL_RAIL_WIDTH_PX } from "@/features/workbench/CollapsiblePanelRail";
import { MediaTimeline } from "@/features/workbench/MediaTimeline";
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
import type {
  AnalysisMode,
  AnalysisStrategy,
  MediaMarker,
  TranscriptCorrectionScope,
  TranscriptionOptions,
} from "@/shared/types";

// 比样式表里 220ms 的面板过渡多留一拍，确保过渡结束前过渡类不被移除
const PANEL_TOGGLE_TRANSITION_MS = 280;

export function MarkersPage() {
  const { selected_asset, selected_asset_id } = use_asset_catalog();
  const {
    start_analysis,
    start_transcription,
    start_transcript_correction,
    restore_transcript_correction,
    respond_to_transcript_correction,
    agent_job_for_asset,
    is_operation_running,
  } = use_task_manager();
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
  const [selected_transcript_indices, set_selected_transcript_indices] =
    useState<number[]>([]);
  const [page_error, set_page_error] = useState<string | null>(null);
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
  const tool_panel_ref = useRef<PanelImperativeHandle>(null);
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

  useEffect(() => {
    mounted_ref.current = true;
    return () => {
      mounted_ref.current = false;
    };
  }, []);

  useEffect(() => {
    set_current_time(0);
    set_selected_transcript_indices([]);
    set_candidate_markers([]);
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

  useEffect(() => {
    if (!selected_asset_id) return;
    void restore_transcript_correction(selected_asset_id)
      .then((job) => {
        if (job?.stage === "complete" && mounted_ref.current) {
          return reload_analysis();
        }
      })
      .catch((error: unknown) => {
        if (mounted_ref.current && !is_abort_error(error)) {
          set_page_error(error_message(error));
        }
      });
  }, [reload_analysis, restore_transcript_correction, selected_asset_id]);

  function seek_player(seconds: number) {
    set_current_time(seconds);
    player_ref.current?.seek_to(seconds);
  }

  async function run_analysis(
    mode: AnalysisMode,
    marker_ids: string[],
    ai_model_id: string | null,
    strategy: AnalysisStrategy,
  ) {
    if (!selected_asset_id) return;
    set_page_error(null);
    try {
      await start_analysis(
        selected_asset_id,
        mode,
        marker_ids,
        ai_model_id,
        strategy,
      );
      if (mounted_ref.current) await reload_analysis();
    } catch (error) {
      if (mounted_ref.current && !is_abort_error(error))
        set_page_error(error_message(error));
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

  async function run_transcript_correction(
    scope: TranscriptCorrectionScope,
    ai_model_id: string,
  ) {
    if (!selected_asset_id) return;
    const segment_indices =
      scope === "all" ? null : selected_transcript_indices;
    if (segment_indices?.length === 0) return;
    set_page_error(null);
    try {
      const job = await start_transcript_correction(
        selected_asset_id,
        segment_indices,
        ai_model_id,
      );
      if (job.stage === "complete" && mounted_ref.current) {
        await reload_analysis();
      }
    } catch (error) {
      if (mounted_ref.current && !is_abort_error(error)) {
        set_page_error(error_message(error));
      }
    }
  }

  async function respond_to_correction_agent(
    action: Parameters<typeof respond_to_transcript_correction>[1],
    ai_model_id?: string | null,
  ) {
    if (!correction_agent_job) return;
    set_page_error(null);
    try {
      const job = await respond_to_transcript_correction(
        correction_agent_job,
        action,
        ai_model_id,
      );
      if (job.stage === "complete" && mounted_ref.current) {
        await reload_analysis();
      }
    } catch (error) {
      if (mounted_ref.current && !is_abort_error(error)) {
        set_page_error(error_message(error));
      }
    }
  }

  function set_tool_panel_collapsed(collapsed: boolean) {
    animate_panel_size_change();
    if (collapsed) tool_panel_ref.current?.collapse();
    else tool_panel_ref.current?.resize(`${settings.tool_panel_size_percent}%`);
    update_settings({ tool_panel_collapsed: collapsed });
  }

  function save_desktop_layout(layout: Record<string, number>) {
    const tool_panel_collapsed = tool_panel_ref.current?.isCollapsed() ?? false;
    const patch: Parameters<typeof update_settings>[0] = {
      tool_panel_collapsed,
    };
    if (layout["agent-panel"] !== undefined) {
      patch.agent_panel_size_percent = layout["agent-panel"];
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
  const correction_agent_job = selected_asset_id
    ? agent_job_for_asset(selected_asset_id)
    : null;
  const correction_is_active =
    correction_agent_job !== null &&
    !["complete", "failed", "cancelled"].includes(correction_agent_job.stage);
  const active_correction_scope: TranscriptCorrectionScope | null =
    correction_is_active
      ? correction_agent_job.segment_indices === null
        ? "all"
        : "selection"
      : null;
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
  const video_workspace = (
    <VideoWorkspace
      asset={selected_asset}
      markers={markers}
      transcript={transcript}
      player_ref={player_ref}
      on_time_change={set_current_time}
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
      on_start_analysis={(mode, marker_ids, ai_model_id, strategy) =>
        void run_analysis(mode, marker_ids, ai_model_id, strategy)
      }
      selected_transcript_count={selected_transcript_indices.length}
      active_correction_scope={active_correction_scope}
      correction_agent_job={correction_agent_job}
      on_start_correction_agent={(scope, ai_model_id) =>
        void run_transcript_correction(scope, ai_model_id)
      }
      on_agent_response={(action, ai_model_id) =>
        void respond_to_correction_agent(action, ai_model_id)
      }
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
          <div className="flex min-h-full flex-col [&>[data-slot=analysis-tools]]:min-h-72 [&>[data-slot=analysis-tools]]:shrink-0 [&>[data-slot=analysis-tools]]:border-t [&>[data-slot=marker-agent-panel]]:max-h-96 [&>[data-slot=marker-agent-panel]]:min-h-64 [&>[data-slot=marker-agent-panel]]:shrink-0 [&>[data-slot=marker-agent-panel]]:border-b [&>[data-slot=video-workspace]]:min-h-120 [&>[data-slot=video-workspace]]:shrink-0 max-[600px]:[&>[data-slot=video-workspace]]:min-h-96">
            {agent_panel}
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
              id="agent-panel"
              defaultSize={`${settings.agent_panel_size_percent}%`}
              minSize="320px"
              maxSize="40%"
            >
              {agent_panel}
            </ResizablePanel>
            <ResizableHandle
              className="hover:bg-primary"
              withHandle
              aria-label="调整 Agent 面板宽度"
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
      <MediaTimeline
        duration_seconds={selected_asset?.duration_seconds ?? null}
        current_time={current_time}
        transcript={transcript}
        segments={segments}
        markers={markers}
        candidate_markers={candidate_markers}
        analysis_strategy={analysis_strategy}
        marker_error={marker_error}
        on_seek={seek_player}
        on_selected_transcript_indices_change={set_selected_transcript_indices}
        on_add_marker={add_marker}
        on_update_marker={update_marker}
        on_delete_marker={remove_marker}
        on_update_transcript={save_transcript_segment}
      />
      {error ? <FloatingError message={error} /> : null}
    </>
  );
}
