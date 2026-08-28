import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import {
  get_markers_page_settings,
  update_markers_page_settings,
} from "@/shared/api";
import { error_message, is_abort_error } from "@/shared/errors";
import type { MarkersPageSettings } from "@/shared/types";

const SETTINGS_SAVE_DELAY_MS = 300;

export const DEFAULT_MARKERS_PAGE_SETTINGS: MarkersPageSettings = {
  left_panel_size_percent: 24,
  left_panel_collapsed: false,
  agent_panel_size_percent: 34,
};

export function use_markers_page_settings() {
  const query_client = useQueryClient();
  const settings_query = useQuery({
    queryKey: RESOURCE_QUERY_KEYS.markers_page_settings,
    queryFn: ({ signal }) => get_markers_page_settings(signal),
  });
  const settings = settings_query.data ?? DEFAULT_MARKERS_PAGE_SETTINGS;
  const [save_error, set_save_error] = useState<string | null>(null);
  const should_save_ref = useRef(false);
  const is_ready = !settings_query.isPending;

  useEffect(() => {
    if (!is_ready || !should_save_ref.current) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      should_save_ref.current = false;
      void update_markers_page_settings(settings, controller.signal)
        .then((saved_settings) => {
          query_client.setQueryData(
            RESOURCE_QUERY_KEYS.markers_page_settings,
            saved_settings,
          );
          set_save_error(null);
        })
        .catch((error: unknown) => {
          if (!is_abort_error(error)) set_save_error(error_message(error));
        });
    }, SETTINGS_SAVE_DELAY_MS);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [is_ready, query_client, settings]);

  const update_settings = useCallback(
    (patch: Partial<MarkersPageSettings>) => {
      should_save_ref.current = true;
      query_client.setQueryData<MarkersPageSettings>(
        RESOURCE_QUERY_KEYS.markers_page_settings,
        (current) => ({
          ...(current ?? DEFAULT_MARKERS_PAGE_SETTINGS),
          ...patch,
        }),
      );
    },
    [query_client],
  );

  const settings_error =
    save_error ??
    (settings_query.error ? error_message(settings_query.error) : null);
  return { settings, settings_error, is_ready, update_settings };
}
