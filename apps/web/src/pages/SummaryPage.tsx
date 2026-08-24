import { useState } from "react";

import { use_asset_catalog } from "@/app/asset_catalog";
import { FloatingError } from "@/components/FloatingError";
import { use_asset_analysis } from "@/features/analysis/use_asset_analysis";
import { SummaryWorkspace } from "@/features/workbench/SummaryWorkspace";

export function SummaryPage() {
  const { selected_asset, selected_asset_id } = use_asset_catalog();
  const { segments, transcript, analysis_error } =
    use_asset_analysis(selected_asset_id);
  const [page_error, set_page_error] = useState<string | null>(null);
  const error = page_error ?? analysis_error;
  return (
    <>
      <SummaryWorkspace
        key={selected_asset_id ?? "no-selected-asset"}
        selected_asset={selected_asset}
        segments={segments}
        transcript={transcript}
        on_error={set_page_error}
      />
      {error ? <FloatingError message={error} /> : null}
    </>
  );
}
