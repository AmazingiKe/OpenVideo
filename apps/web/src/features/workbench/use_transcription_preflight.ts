import { useEffect, useState } from "react";

import {
  check_transcription,
  type TranscriptionPreflight,
} from "@/shared/api/transcription_preflight";
import { error_message } from "@/shared/errors";
import type { TranscriptionOptions } from "@/shared/types";

const PREFLIGHT_TIMEOUT_MS = 15_000;

export function use_transcription_preflight(
  enabled: boolean,
  asset_ids: string[],
  options: TranscriptionOptions | null,
) {
  const [revision, set_revision] = useState(0);
  const request_key = JSON.stringify({ enabled, asset_ids, options, revision });
  const [result, set_result] = useState<{
    key: string;
    check: TranscriptionPreflight | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    const request = JSON.parse(request_key) as {
      enabled: boolean;
      asset_ids: string[];
      options: TranscriptionOptions | null;
    };
    if (!request.enabled || !request.options || request.asset_ids.length === 0)
      return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      controller.abort();
      set_result({
        key: request_key,
        check: null,
        error: "检查超时，请确认后台连接后重新检查",
      });
    }, PREFLIGHT_TIMEOUT_MS);
    void check_transcription(
      request.asset_ids,
      request.options,
      controller.signal,
    )
      .then((check) => {
        if (!controller.signal.aborted)
          set_result({ key: request_key, check, error: null });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          set_result({
            key: request_key,
            check: null,
            error: error_message(error),
          });
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [request_key]);
  const current_result = result?.key === request_key ? result : null;
  return {
    check: current_result?.check ?? null,
    error: current_result?.error ?? null,
    checking: enabled && current_result === null,
    recheck: () => set_revision((current) => current + 1),
  };
}
