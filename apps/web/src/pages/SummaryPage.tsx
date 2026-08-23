import { useEffect, useState } from "react";

import { use_asset_catalog } from "@/app/asset_catalog";
import { FloatingError } from "@/components/FloatingError";
import { use_asset_analysis } from "@/features/analysis/use_asset_analysis";
import { SummaryWorkspace } from "@/features/workbench/SummaryWorkspace";
import { error_message, is_abort_error } from "@/shared/errors";

export function SummaryPage() {
  const { selected_asset, selected_asset_id, refresh_assets } =
    use_asset_catalog();
  const { segments, transcript, analysis_error } =
    use_asset_analysis(selected_asset_id);
  const [page_error, set_page_error] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void refresh_assets(controller.signal).catch((error: unknown) => {
      if (!is_abort_error(error)) set_page_error(error_message(error));
    });
    return () => controller.abort();
  }, [refresh_assets]);

  const error = page_error ?? analysis_error;
  return (
    <>
      <SummaryWorkspace
        selected_asset={selected_asset}
        segments={segments}
        transcript={transcript}
      />
      {error ? <FloatingError message={error} /> : null}
    </>
  );
}
