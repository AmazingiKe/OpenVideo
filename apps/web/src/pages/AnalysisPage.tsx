import { useEffect, useRef, useState } from "react";

import { use_asset_catalog } from "@/app/asset_catalog";
import { use_task_manager } from "@/app/task_manager";
import { use_asset_analysis } from "@/features/analysis/use_asset_analysis";
import { type PlayerHandle } from "@/features/player/Player";
import { use_asset_markers } from "@/features/player/use_asset_markers";
import { AssetLibrary } from "@/features/workbench/AssetLibrary";
import { MediaTimeline } from "@/features/workbench/MediaTimeline";
import { VideoWorkspace } from "@/features/workbench/VideoWorkspace";
import { error_message, is_abort_error } from "@/shared/errors";
import type { AnalysisMode, TranscriptionOptions } from "@/shared/types";

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
  } = use_asset_analysis(selected_asset_id);
  const [current_time, set_current_time] = useState(0);
  const [page_error, set_page_error] = useState<string | null>(null);
  const player_ref = useRef<PlayerHandle>(null);
  const mounted_ref = useRef(true);
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

  useEffect(() => set_current_time(0), [selected_asset_id]);

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

  const error = page_error ?? analysis_error;
  return (
    <>
      <AssetLibrary
        assets={assets}
        selected_asset_id={selected_asset_id}
        on_select={select_asset}
      />
      <VideoWorkspace
        asset={selected_asset}
        markers={markers}
        transcript={transcript}
        player_ref={player_ref}
        on_time_change={set_current_time}
        has_transcript={transcript !== null}
        is_transcribing={
          selected_asset_id
            ? is_operation_running(selected_asset_id, "transcription")
            : false
        }
        on_start_transcription={(options) => void run_transcription(options)}
        is_analyzing={
          selected_asset_id
            ? is_operation_running(selected_asset_id, "analysis")
            : false
        }
        on_start_analysis={(mode, marker_ids) =>
          void run_analysis(mode, marker_ids)
        }
      />
      <MediaTimeline
        duration_seconds={selected_asset?.duration_seconds ?? null}
        current_time={current_time}
        transcript={transcript}
        segments={segments}
        markers={markers}
        marker_error={marker_error}
        on_seek={seek_player}
        on_add_marker={add_marker}
        on_remove_marker={remove_marker}
        on_update_marker_tags={update_marker_tags}
        on_update_transcript={save_transcript_segment}
      />
      {error ? (
        <p className="workbench_error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
