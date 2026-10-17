import type { Transcript } from "../types";
import { request_json } from "./client";

export type TranscriptVersion = {
  version_id: string;
  saved_at: string;
  reason: "replacement" | "edit" | "restore";
  segment_count: number;
};

export function list_transcript_versions(
  asset_id: string,
  signal: AbortSignal,
): Promise<TranscriptVersion[]> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/transcript/versions`,
    { signal },
  );
}

export function get_transcript_version(
  asset_id: string,
  version_id: string,
  signal: AbortSignal,
): Promise<Transcript> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/transcript/versions/${encodeURIComponent(version_id)}`,
    { signal },
  );
}

export function restore_transcript_version(
  asset_id: string,
  version_id: string,
  signal: AbortSignal,
): Promise<Transcript> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/transcript/versions/${encodeURIComponent(version_id)}/restore`,
    { method: "POST", signal },
  );
}
