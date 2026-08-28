import type { EventAnalysis, FocusSelection } from "../types";
import { api_base_url, ApiError, request_json } from "./client";

export async function get_focus_selection(
  asset_id: string,
  signal?: AbortSignal,
): Promise<FocusSelection | null> {
  try {
    return await request_json(
      `/api/media/assets/${encodeURIComponent(asset_id)}/focus-selection`,
      { signal },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export function update_focus_selection(
  asset_id: string,
  patch: { in_seconds?: number | null; out_seconds?: number | null },
  signal?: AbortSignal,
): Promise<FocusSelection> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/focus-selection`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
      signal,
    },
  );
}

export async function clear_focus_selection(
  asset_id: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${api_base_url}/api/media/assets/${encodeURIComponent(asset_id)}/focus-selection`,
    { method: "DELETE", signal },
  );
  if (!response.ok) {
    throw new ApiError(`请求失败（${response.status}）`, response.status);
  }
}

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
