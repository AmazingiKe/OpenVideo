import type { EventAnalysis } from "../types";
import { api_base_url, ApiError, request_json } from "./client";

export function list_event_analyses(
  asset_id: string,
  signal?: AbortSignal,
): Promise<EventAnalysis[]> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/event-analyses`,
    { signal },
  );
}

export async function delete_event_analysis(
  event_analysis_id: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${api_base_url}/api/event-analyses/${encodeURIComponent(event_analysis_id)}`,
    { method: "DELETE", signal },
  );
  if (!response.ok) {
    throw new ApiError(`请求失败（${response.status}）`, response.status);
  }
}
