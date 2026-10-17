import type { TranscriptionOptions } from "../types";
import { request_json } from "./client";

export type CloudSubmissionStatus = {
  job_id: string;
  uncertain: boolean;
  cloud_task_id: string | null;
  options: TranscriptionOptions;
};

export type CloudSubmissionResolution =
  { cloud_task_id: string } | { confirm_not_submitted: true };

export function get_cloud_submission_status(
  asset_id: string,
  signal: AbortSignal,
): Promise<CloudSubmissionStatus | null> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/transcription-submission`,
    { signal },
  );
}

export function resolve_cloud_submission(
  asset_id: string,
  job_id: string,
  resolution: CloudSubmissionResolution,
  signal: AbortSignal,
): Promise<CloudSubmissionStatus> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/transcription-submission`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id, ...resolution }),
      signal,
    },
  );
}
