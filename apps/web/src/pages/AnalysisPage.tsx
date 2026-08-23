import { useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

import { use_asset_catalog } from "@/app/asset_catalog";
import { use_task_manager } from "@/app/task_manager";
import { use_asset_analysis } from "@/features/analysis/use_asset_analysis";
import { use_analysis_page_settings } from "@/features/analysis/use_analysis_page_settings";
import { use_compact_analysis_layout } from "@/features/analysis/use_compact_analysis_layout";
import { type PlayerHandle } from "@/features/player/Player";
import { use_asset_markers } from "@/features/player/use_asset_markers";
import { AssetLibrary } from "@/features/workbench/AssetLibrary";
import { AnalysisToolPanel } from "@/features/workbench/AnalysisToolPanel";
import { MediaTimeline } from "@/features/workbench/MediaTimeline";
import { VideoWorkspace } from "@/features/workbench/VideoWorkspace";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Spinner } from "@/components/ui/spinner";
import { FloatingError } from "@/components/FloatingError";
import { error_message, is_abort_error } from "@/shared/errors";
import type {
  AnalysisMode,
  TranscriptCorrectionScope,
  TranscriptionOptions,
} from "@/shared/types";

export function AnalysisPage() {
  const {
    assets,
    selected_asset,
    selected_asset_id,
    refresh_assets,
    select_asset,
  } = use_asset_catalog();
  const { start_analysis, start_transcription, is_operation_running } =
    use_task_manager();
  const {
    segments,
    transcript,
    analysis_error,
    reload_analysis,
    save_transcript_segment,
    correct_transcript_segments,
  } = use_asset_analysis(selected_asset_id);
  const { settings, settings_error, is_ready, update_settings } =
    use_analysis_page_settings();
  const [current_time, set_current_time] = useState(0);
  const [selected_transcript_indices, set_selected_transcript_indices] =
    useState<number[]>([]);
  const [active_correction_scope, set_active_correction_scope] =
    useState<TranscriptCorrectionScope | null>(null);
  const [page_error, set_page_error] = useState<string | null>(null);
  const player_ref = useRef<PlayerHandle>(null);
  const asset_library_panel_ref = useRef<PanelImperativeHandle>(null);
  const tool_panel_ref = useRef<PanelImperativeHandle>(null);
  const mounted_ref = useRef(true);
  const is_compact_layout = use_compact_analysis_layout();
  const {
    markers,
    marker_error,
    add_marker,
    update_marker_tags,
    remove_marker,
  } = use_asset_markers(selected_asset_id ?? "");

  useEffect(() => {
    mounted_ref.current = true;
    const controller = new AbortController();
    void refresh_assets(controller.signal).catch((error: unknown) => {
      if (!is_abort_error(error)) set_page_error(error_message(error));
    });
    return () => {
      mounted_ref.current = false;
      controller.abort();
    };
  }, [refresh_assets]);

  useEffect(() => {
    set_current_time(0);
    set_selected_transcript_indices([]);
    set_active_correction_scope(null);
  }, [selected_asset_id]);

  function seek_player(seconds: number) {
    set_current_time(seconds);
    player_ref.current?.seek_to(seconds);
  }

  async function run_analysis(mode: AnalysisMode, marker_ids: string[]) {
    if (!selected_asset_id) return;
    set_page_error(null);
    try {
      await start_analysis(selected_asset_id, mode, marker_ids);
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

  async function run_transcript_correction(scope: TranscriptCorrectionScope) {
    if (!selected_asset_id) return;
    const segment_indices =
      scope === "all" ? null : selected_transcript_indices;
    if (segment_indices?.length === 0) return;
    set_active_correction_scope(scope);
    set_page_error(null);
    try {
      await correct_transcript_segments(segment_indices);
    } catch (error) {
      if (mounted_ref.current && !is_abort_error(error)) {
        set_page_error(error_message(error));
      }
    } finally {
      if (mounted_ref.current) set_active_correction_scope(null);
    }
  }

  function set_asset_library_collapsed(collapsed: boolean) {
    if (collapsed) asset_library_panel_ref.current?.collapse();
    else
      asset_library_panel_ref.current?.resize(
        `${settings.asset_library_size_percent}%`,
      );
    update_settings({ asset_library_collapsed: collapsed });
  }

  function set_tool_panel_collapsed(collapsed: boolean) {
    if (collapsed) tool_panel_ref.current?.collapse();
    else tool_panel_ref.current?.resize(`${settings.tool_panel_size_percent}%`);
    update_settings({ tool_panel_collapsed: collapsed });
  }

  function save_desktop_layout(layout: Record<string, number>) {
    const asset_library_collapsed =
      asset_library_panel_ref.current?.isCollapsed() ?? false;
    const tool_panel_collapsed = tool_panel_ref.current?.isCollapsed() ?? false;
    const patch: Parameters<typeof update_settings>[0] = {
      asset_library_collapsed,
      tool_panel_collapsed,
    };
    if (!asset_library_collapsed && layout["asset-library"] !== undefined) {
      patch.asset_library_size_percent = layout["asset-library"];
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
  const asset_library = (
    <AssetLibrary
      assets={assets}
      selected_asset_id={selected_asset_id}
      on_select={select_asset}
      collapsed={!is_compact_layout && settings.asset_library_collapsed}
      on_collapsed_change={
        is_compact_layout ? undefined : set_asset_library_collapsed
      }
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
      is_analyzing={is_analyzing}
      on_start_analysis={(mode, marker_ids) =>
        void run_analysis(mode, marker_ids)
      }
      selected_transcript_count={selected_transcript_indices.length}
      active_correction_scope={active_correction_scope}
      on_correct_transcript={(scope) => void run_transcript_correction(scope)}
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

  const error = page_error ?? settings_error ?? analysis_error;
  return (
    <>
      <div className="min-h-0 min-w-0 overflow-hidden max-[979px]:overflow-auto">
        {!is_ready ? (
          <div
            className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <Spinner />
            正在恢复工作台布局
          </div>
        ) : is_compact_layout ? (
          <div className="flex min-h-full flex-col [&>[data-slot=analysis-tools]]:min-h-72 [&>[data-slot=analysis-tools]]:shrink-0 [&>[data-slot=analysis-tools]]:border-t [&>[data-slot=asset-library]]:max-h-60 [&>[data-slot=asset-library]]:min-h-44 [&>[data-slot=asset-library]]:shrink-0 [&>[data-slot=asset-library]]:border-r-0 [&>[data-slot=asset-library]]:border-b [&>[data-slot=video-workspace]]:min-h-120 [&>[data-slot=video-workspace]]:shrink-0 max-[600px]:[&>[data-slot=video-workspace]]:min-h-96">
            {asset_library}
            {video_workspace}
            {tool_panel}
          </div>
        ) : (
          <ResizablePanelGroup
            id="analysis-workspace"
            orientation="horizontal"
            onLayoutChanged={(layout, metadata) => {
              if (metadata.isUserInteraction) save_desktop_layout(layout);
            }}
          >
            <ResizablePanel
              id="asset-library"
              panelRef={asset_library_panel_ref}
              defaultSize={
                settings.asset_library_collapsed
                  ? "48px"
                  : `${settings.asset_library_size_percent}%`
              }
              minSize="10%"
              maxSize="28%"
              collapsedSize="48px"
              collapsible
            >
              {asset_library}
            </ResizablePanel>
            <ResizableHandle
              className="hover:bg-primary"
              withHandle
              aria-label="调整视频库宽度"
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
                  ? "48px"
                  : `${settings.tool_panel_size_percent}%`
              }
              minSize="14%"
              maxSize="32%"
              collapsedSize="48px"
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
        marker_error={marker_error}
        selected_transcript_indices={selected_transcript_indices}
        on_seek={seek_player}
        on_selected_transcript_indices_change={set_selected_transcript_indices}
        on_add_marker={add_marker}
        on_remove_marker={remove_marker}
        on_update_marker_tags={update_marker_tags}
        on_update_transcript={save_transcript_segment}
      />
      {error ? <FloatingError message={error} /> : null}
    </>
  );
}
