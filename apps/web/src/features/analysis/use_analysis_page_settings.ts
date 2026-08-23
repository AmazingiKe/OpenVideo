import { useCallback, useEffect, useRef, useState } from "react";

import {
  get_analysis_page_settings,
  update_analysis_page_settings,
} from "@/shared/api";
import { error_message, is_abort_error } from "@/shared/errors";
import type { AnalysisPageSettings } from "@/shared/types";

const SETTINGS_SAVE_DELAY_MS = 300;

export const DEFAULT_ANALYSIS_PAGE_SETTINGS: AnalysisPageSettings = {
  asset_library_size_percent: 14,
  asset_library_collapsed: false,
  tool_panel_size_percent: 16,
  tool_panel_collapsed: false,
  open_tool_sections: ["video_information"],
};

export function use_analysis_page_settings() {
  const [settings, set_settings] = useState<AnalysisPageSettings>(
    DEFAULT_ANALYSIS_PAGE_SETTINGS,
  );
  const [is_ready, set_is_ready] = useState(false);
  const [settings_error, set_settings_error] = useState<string | null>(null);
  const should_save_ref = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void get_analysis_page_settings(controller.signal)
      .then((loaded_settings) => {
        set_settings(loaded_settings);
        set_settings_error(null);
      })
      .catch((error: unknown) => {
        if (!is_abort_error(error)) set_settings_error(error_message(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) set_is_ready(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!is_ready || !should_save_ref.current) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      should_save_ref.current = false;
      void update_analysis_page_settings(settings, controller.signal)
        .then(() => set_settings_error(null))
        .catch((error: unknown) => {
          if (!is_abort_error(error)) set_settings_error(error_message(error));
        });
    }, SETTINGS_SAVE_DELAY_MS);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [is_ready, settings]);

  const update_settings = useCallback(
    (patch: Partial<AnalysisPageSettings>) => {
      should_save_ref.current = true;
      set_settings((current) => ({ ...current, ...patch }));
    },
    [],
  );

  return { settings, settings_error, is_ready, update_settings };
}
