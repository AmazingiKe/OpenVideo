import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { useNavigate } from "react-router-dom";

import { use_asset_catalog } from "@/app/asset_catalog";
import {
  GlobalAssistantRegistration,
  use_global_assistant_controls,
} from "@/app/global_assistant";
import { use_local_preferences } from "@/app/local_preferences";
import { use_task_manager } from "@/app/task_manager";
import { marker_asset_path } from "@/app/workspace_routes";
import { use_asset_analysis } from "@/features/analysis/use_asset_analysis";
import { use_transcription_resources } from "@/features/workbench/use_processing_resources";
import { use_compact_markers_layout } from "@/features/markers/use_compact_markers_layout";
import { use_markers_page_settings } from "@/features/markers/use_markers_page_settings";
import { MarkerLibraryPanel } from "@/features/markers/MarkerLibraryPanel";
import { evidence_range_for_asset } from "@/features/markers/evidence_navigation";
import { type PlayerHandle } from "@/features/player/Player";
import { use_asset_markers } from "@/features/markers/use_asset_markers";
import {
  TranscriptionToolbarTools,
  type TranscriptCorrectionRequest,
  type TranscriptCorrectionScope,
} from "@/features/workbench/TranscriptionToolbarTools";
import { PANEL_RAIL_WIDTH_PX } from "@/features/workbench/CollapsiblePanelRail";
import { VideoWorkspace } from "@/features/workbench/VideoWorkspace";
import { timeline_agent_focus } from "@/features/workbench/timeline_agent_context";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { FloatingError } from "@/components/FloatingError";
import type { AgentContextAttachmentDraft } from "@/components/agent_context";
import { cn } from "@/lib/utils";
import { error_message, is_abort_error } from "@/shared/errors";
import { uuid7 } from "@/shared/identifiers";
import { DEFAULT_ANALYSIS_STRATEGY } from "@/shared/analysis";
import { delete_event_analysis, list_event_analyses } from "@/shared/api";
import type {
  AgentArtifact,
  AgentEvidenceRange,
  AgentEvidenceReference,
  EventAnalysis,
  FocusSelection,
  MediaMarker,
  TranscriptionOptions,
} from "@/shared/types";

type TranscriptCorrectionTask = TranscriptCorrectionRequest & {
  segment_indices: number[] | null;
};

const MediaTimeline = lazy(() =>
  import("@/features/workbench/MediaTimeline").then((module) => ({
    default: module.MediaTimeline,
  })),
);

// 比样式表里 220ms 的面板过渡多留一拍，确保过渡结束前过渡类不被移除
const PANEL_TOGGLE_TRANSITION_MS = 280;
const LIBRARY_PANEL_MIN_WIDTH_PX = 320;
const LIBRARY_PANEL_MAX_WIDTH_PERCENT = 40;
const VIDEO_PANEL_MIN_WIDTH_PX = 400;
const PREVIEW_PANEL_MIN_HEIGHT_PX = 144;
const TIMELINE_PANEL_DEFAULT_HEIGHT_PX = 264;
const TIMELINE_PANEL_MIN_HEIGHT_PX = 176;
const TIMELINE_PANEL_MAX_HEIGHT_PERCENT = 65;

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
  const { preferences, set_video_library_open } = use_local_preferences();
  const library_open =
    preferences.video_library_open ?? selected_asset_id === null;
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
  const [transcript_correction_task, set_transcript_correction_task] =
    useState<TranscriptCorrectionTask | null>(null);
  const [page_error, set_page_error] = useState<string | null>(null);
  const [focus_selection, set_focus_selection] =
    useState<FocusSelection | null>(null);
  const [agent_context_attachments, set_agent_context_attachments] = useState<
    AgentContextAttachmentDraft[]
  >([]);
  const [evidence_range, set_evidence_range] =
    useState<AgentEvidenceRange | null>(null);
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
    set_transcript_correction_task(null);
    set_candidate_markers([]);
    set_focus_selection(null);
    set_agent_context_attachments([]);
    set_evidence_range(null);
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
    void list_event_analyses(selected_asset_id, controller.signal)
      .then((analyses) => {
        if (!mounted_ref.current) return;
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

  function set_library_open(open: boolean) {
    animate_panel_size_change();
    if (open) {
      left_panel_ref.current?.resize(`${settings.left_panel_size_percent}%`);
    } else {
      left_panel_ref.current?.collapse();
    }
    set_video_library_open(open);
  }

  useEffect(() => {
    if (!is_ready || is_compact_layout) return;
    if (library_open) {
      left_panel_ref.current?.resize(`${settings.left_panel_size_percent}%`);
    } else {
      left_panel_ref.current?.collapse();
    }
  }, [
    is_ready,
    is_compact_layout,
    library_open,
    settings.left_panel_size_percent,
  ]);

  function seek_player(seconds: number) {
    set_current_time(seconds);
    player_ref.current?.seek_to(seconds);
  }

  function seek_agent_evidence(
    seconds: number,
    end_seconds?: number | null,
    evidence?: AgentEvidenceReference,
  ) {
    set_evidence_range(
      evidence_range_for_asset(selected_asset_id, evidence, end_seconds),
    );
    seek_player(seconds);
  }

  async function handle_assistant_artifact(artifact: AgentArtifact) {
    if (artifact.result_type === "transcript_correction") {
      if (artifact.status === "approved") await reload_analysis();
      return;
    }
    if (artifact.result_type !== "marker_changes") return;
    if (artifact.status === "approved") {
      set_candidate_markers([]);
      await reload_markers();
      return;
    }
    if (artifact.status !== "pending") {
      set_candidate_markers([]);
      return;
    }
    const changes = Array.isArray(artifact.payload.changes)
      ? (artifact.payload.changes as Record<string, unknown>[])
      : [];
    set_candidate_markers(
      changes.flatMap((change) => {
        if (typeof change.after !== "object" || change.after === null)
          return [];
        return [change.after as MediaMarker];
      }),
    );
  }
  const focus_context = timeline_agent_focus({
    playhead_seconds: current_time,
    segments,
    selected_marker_ids: [...selected_marker_ids],
    selected_transcript_indices,
    focus_selection,
  });
  const assistant_binding = {
    agent_id: transcript_correction_task ? "transcript_correction" : "marker",
    asset_id: selected_asset_id,
    focus_context,
    context_label: transcript_correction_task
      ? `字幕修正 · ${
          transcript_correction_task.scope === "selection"
            ? `已选择 ${transcript_correction_task.segment_indices?.length ?? 0} 条`
            : "全部字幕"
        }`
      : selected_asset
        ? `当前视频 · ${selected_asset.title}`
        : "尚未选择视频",
    task_input: transcript_correction_task
      ? {
          segment_indices: transcript_correction_task.segment_indices,
          correction_instruction: transcript_correction_task.instruction,
          execution_mode: "automatic",
        }
      : {},
    context_attachments: transcript_correction_task
      ? []
      : agent_context_attachments,
    placeholder: transcript_correction_task
      ? undefined
      : "询问视频内容，或直接描述希望创建的标记…",
    panel_size_percent: settings.agent_panel_size_percent,
    on_panel_size_percent_change: (agent_panel_size_percent: number) =>
      update_settings({ agent_panel_size_percent }),
    on_seek: seek_agent_evidence,
    current_time,
    on_artifact_change: handle_assistant_artifact,
  };
  const { open_assistant } = use_global_assistant_controls();

  function preview_player(seconds: number) {
    player_ref.current?.preview_to(seconds);
  }

  function set_range_endpoint(
    endpoint: "in_seconds" | "out_seconds",
    seconds: number,
  ) {
    if (!selected_asset_id) return;
    set_focus_selection((current) => {
      const selection: FocusSelection = current ?? {
        selection_id: `focus-selection-${uuid7().replaceAll("-", "")}`,
        asset_id: selected_asset_id,
        in_seconds: null,
        out_seconds: null,
        revision: 0,
        updated_at: new Date().toISOString(),
      };
      const next_selection = {
        ...selection,
        [endpoint]: seconds,
        revision: selection.revision + 1,
        updated_at: new Date().toISOString(),
      };
      if (
        endpoint === "in_seconds" &&
        next_selection.out_seconds !== null &&
        seconds >= next_selection.out_seconds
      ) {
        next_selection.out_seconds = null;
      }
      if (
        endpoint === "out_seconds" &&
        next_selection.in_seconds !== null &&
        seconds <= next_selection.in_seconds
      ) {
        next_selection.in_seconds = null;
      }
      return next_selection;
    });
  }

  function clear_range() {
    set_focus_selection(null);
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

  function save_library_layout(layout: Record<string, number>) {
    const panel_open = !(
      left_panel_ref.current?.isCollapsed() ?? !library_open
    );
    const left_panel_size_percent = layout["left-panel"];
    if (panel_open && left_panel_size_percent !== undefined) {
      update_settings({ left_panel_size_percent });
    }
  }

  function open_library_video(asset_id: string) {
    set_library_open(false);
    navigate(marker_asset_path(asset_id));
  }

  function open_transcript_correction(segment_indices: number[]) {
    set_selected_transcript_indices(segment_indices);
    set_transcript_correction_scope(
      segment_indices.length > 0 ? "selection" : "all",
    );
    set_transcript_correction_task(null);
    set_transcript_correction_open(true);
  }

  function request_transcript_correction(request: TranscriptCorrectionRequest) {
    set_transcript_correction_task({
      ...request,
      segment_indices:
        request.scope === "selection" ? [...selected_transcript_indices] : null,
    });
    open_assistant();
  }

  const is_transcribing = selected_asset_id
    ? is_transcription_running(selected_asset_id)
    : false;
  const transcription_models = loaded_transcription_models.map(
    (model) =>
      transcription_model_overrides[`${model.engine}:${model.model}`] ?? model,
  );
  const library_panel = (
    <MarkerLibraryPanel
      collapsed={!library_open}
      current_video_id={selected_asset_id}
      initial_folder_id={selected_asset ? selected_asset.folder_id : undefined}
      on_collapsed_change={(collapsed) => set_library_open(!collapsed)}
      on_open_video={(asset) => open_library_video(asset.asset_id)}
    />
  );
  const compact_library_launcher = (
    <MarkerLibraryPanel
      collapsed
      compact
      current_video_id={selected_asset_id}
      initial_folder_id={selected_asset ? selected_asset.folder_id : undefined}
      on_collapsed_change={(collapsed) => {
        if (!collapsed) set_video_library_open(true);
      }}
      on_open_video={(asset) => open_library_video(asset.asset_id)}
    />
  );
  const video_workspace = (
    <VideoWorkspace
      asset={selected_asset}
      markers={markers}
      transcript={transcript}
      evidence_range={evidence_range}
      player_ref={player_ref}
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
      selected_transcript_indices={selected_transcript_indices}
      correction_open={transcript_correction_open}
      correction_scope={transcript_correction_scope}
      on_correction_open_change={(open) => {
        if (open) set_transcript_correction_task(null);
        set_transcript_correction_open(open);
      }}
      on_correction_scope_change={set_transcript_correction_scope}
      on_request_correction={request_transcript_correction}
    />
  );

  const error =
    page_error ??
    transcription_resources_error ??
    settings_error ??
    analysis_error;
  const timeline = (
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
        evidence_range={evidence_range}
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
        on_selected_transcript_indices_change={set_selected_transcript_indices}
        on_request_transcript_correction={open_transcript_correction}
        on_selected_marker_ids_change={set_selected_marker_ids}
        on_set_focus_in={(seconds) => set_range_endpoint("in_seconds", seconds)}
        on_set_focus_out={(seconds) =>
          set_range_endpoint("out_seconds", seconds)
        }
        on_clear_focus={clear_range}
        on_add_agent_context={(attachment) =>
          set_agent_context_attachments((current) => [...current, attachment])
        }
        on_delete_event_analysis={remove_event_analysis}
        on_add_marker={add_marker}
        on_update_marker={update_marker}
        on_delete_marker={remove_marker}
        on_update_transcript={save_transcript_segment}
        toolbar_tools={transcription_tools}
      />
    </Suspense>
  );
  return (
    <>
      <GlobalAssistantRegistration binding={assistant_binding} />
      <div
        className={cn(
          "h-full min-h-0 min-w-0 overflow-hidden",
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
        ) : (
          <section
            className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
            aria-label="标记工作区"
          >
            <ResizablePanelGroup id="markers-workspace" orientation="vertical">
              <ResizablePanel
                id="markers-preview"
                minSize={`${PREVIEW_PANEL_MIN_HEIGHT_PX}px`}
                className="min-h-0 overflow-hidden"
              >
                {is_compact_layout ? (
                  <div className="flex h-full min-h-0 flex-col overflow-hidden">
                    {compact_library_launcher}
                    <div className="min-h-0 flex-1">{video_workspace}</div>
                    <Sheet
                      open={library_open}
                      onOpenChange={set_video_library_open}
                    >
                      <SheetContent
                        side="left"
                        className="w-[min(92vw,24rem)] gap-0 p-0"
                        showCloseButton={false}
                      >
                        <SheetHeader className="sr-only">
                          <SheetTitle>视频库</SheetTitle>
                          <SheetDescription>
                            选择一个视频并在标记工作区中打开
                          </SheetDescription>
                        </SheetHeader>
                        <MarkerLibraryPanel
                          compact
                          current_video_id={selected_asset_id}
                          initial_folder_id={
                            selected_asset
                              ? selected_asset.folder_id
                              : undefined
                          }
                          on_collapsed_change={(collapsed) => {
                            if (collapsed) set_video_library_open(false);
                          }}
                          on_open_video={(asset) =>
                            open_library_video(asset.asset_id)
                          }
                        />
                      </SheetContent>
                    </Sheet>
                  </div>
                ) : (
                  <ResizablePanelGroup
                    id="markers-library-workspace"
                    orientation="horizontal"
                    onLayoutChanged={(layout, metadata) => {
                      if (metadata.isUserInteraction)
                        save_library_layout(layout);
                    }}
                  >
                    <ResizablePanel
                      id="left-panel"
                      panelRef={left_panel_ref}
                      defaultSize={
                        library_open
                          ? `${settings.left_panel_size_percent}%`
                          : `${PANEL_RAIL_WIDTH_PX}px`
                      }
                      minSize={`${LIBRARY_PANEL_MIN_WIDTH_PX}px`}
                      maxSize={`${LIBRARY_PANEL_MAX_WIDTH_PERCENT}%`}
                      collapsedSize={`${PANEL_RAIL_WIDTH_PX}px`}
                      collapsible
                      onResize={(size) => {
                        const collapsed =
                          size.inPixels <= PANEL_RAIL_WIDTH_PX + 1;
                        const panel_open = !collapsed;
                        if (panel_open !== library_open) {
                          set_video_library_open(panel_open);
                        }
                      }}
                    >
                      {library_panel}
                    </ResizablePanel>
                    <ResizableHandle
                      className="hover:bg-primary"
                      withHandle
                      aria-label="调整视频库宽度"
                    />
                    <ResizablePanel
                      id="video-player"
                      minSize={`${VIDEO_PANEL_MIN_WIDTH_PX}px`}
                    >
                      {video_workspace}
                    </ResizablePanel>
                  </ResizablePanelGroup>
                )}
              </ResizablePanel>
              <ResizableHandle
                className="hover:bg-primary"
                withHandle
                aria-label="调整时间线高度"
              />
              <ResizablePanel
                id="markers-timeline"
                defaultSize={`${TIMELINE_PANEL_DEFAULT_HEIGHT_PX}px`}
                minSize={`${TIMELINE_PANEL_MIN_HEIGHT_PX}px`}
                maxSize={`${TIMELINE_PANEL_MAX_HEIGHT_PERCENT}%`}
                groupResizeBehavior="preserve-pixel-size"
                className="min-h-0 overflow-hidden"
              >
                {timeline}
              </ResizablePanel>
            </ResizablePanelGroup>
          </section>
        )}
      </div>
      {error ? <FloatingError message={error} /> : null}
    </>
  );
}
