import { useState } from "react";

import { use_asset_catalog } from "@/app/asset_catalog";
import { use_local_preferences } from "@/app/local_preferences";
import { FloatingError } from "@/components/FloatingError";
import { use_asset_analysis } from "@/features/analysis/use_asset_analysis";
import { FloatingSummaryPlayer } from "@/features/summary/FloatingSummaryPlayer";
import { SummaryWorkspace } from "@/features/workbench/SummaryWorkspace";

export function SummaryPage() {
  const { selected_asset, selected_asset_id } = use_asset_catalog();
  const { preferences, set_summary_player_geometry, set_summary_player_open } =
    use_local_preferences();
  const { transcript, analysis_error } = use_asset_analysis(selected_asset_id);
  const [page_error, set_page_error] = useState<string | null>(null);
  const media_available = Boolean(selected_asset?.playback_url);
  const player_open =
    media_available && (preferences.summary_player_open ?? false);
  const error = page_error ?? analysis_error;

  return (
    <>
      <div className="relative h-full min-h-0 min-w-0 overflow-hidden">
        <SummaryWorkspace
          key={selected_asset_id ?? "no-selected-asset"}
          selected_asset={selected_asset}
          on_error={set_page_error}
        />
        <FloatingSummaryPlayer
          asset={selected_asset}
          geometry={preferences.summary_player_geometry}
          open={player_open}
          on_geometry_change={set_summary_player_geometry}
          on_open_change={set_summary_player_open}
          transcript={transcript}
        />
      </div>
      {error ? <FloatingError message={error} /> : null}
    </>
  );
}
