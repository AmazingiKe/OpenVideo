import type { TranscriptionOptions } from "../types";
import { request_json } from "./client";

export type TranscriptionPreflight = {
  ready: boolean;
  issues: string[];
  notes: string[];
};

export function check_transcription(
  asset_ids: string[],
  options: TranscriptionOptions,
  signal: AbortSignal,
): Promise<TranscriptionPreflight> {
  return request_json("/api/transcription/preflight", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ asset_ids, options }),
    signal,
  });
}
