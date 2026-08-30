import type { VisualIndexStatus } from "../types";
import { request_json } from "./client";

export function get_visual_index_status(
  signal?: AbortSignal,
): Promise<VisualIndexStatus> {
  return request_json("/api/visual-index/status", { signal });
}

export function prepare_visual_index(
  asset_id: string | null = null,
  signal?: AbortSignal,
): Promise<VisualIndexStatus> {
  return request_json("/api/visual-index/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ asset_id }),
    signal,
  });
}

export function unload_visual_index(
  signal?: AbortSignal,
): Promise<VisualIndexStatus> {
  return request_json("/api/visual-index/unload", {
    method: "POST",
    signal,
  });
}
