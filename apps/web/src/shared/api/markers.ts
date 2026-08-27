import type {
  MediaMarker,
  MediaMarkerCreate,
  MediaMarkerUpdate,
} from "../types";
import { api_base_url, ApiError, request_json } from "./client";

export function get_markers(
  asset_id: string,
  signal?: AbortSignal,
): Promise<MediaMarker[]> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/markers`,
    { signal },
  );
}

export function create_marker(
  asset_id: string,
  marker: MediaMarkerCreate,
  signal?: AbortSignal,
): Promise<MediaMarker> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/markers`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(marker),
      signal,
    },
  );
}

export function update_marker(
  asset_id: string,
  marker_id: string,
  update: MediaMarkerUpdate,
  signal?: AbortSignal,
): Promise<MediaMarker> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/markers/${encodeURIComponent(marker_id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
      signal,
    },
  );
}

export async function delete_marker(
  asset_id: string,
  marker_id: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${api_base_url}/api/media/assets/${encodeURIComponent(asset_id)}/markers/${encodeURIComponent(marker_id)}`,
    { method: "DELETE", signal },
  );
  if (!response.ok) {
    throw new ApiError(`请求失败（${response.status}）`, response.status);
  }
}
