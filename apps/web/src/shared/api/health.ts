import type { BackendProbeResponse, HealthResponse } from "../types";
import { request_json } from "./client";

export function probe_backend(
  signal?: AbortSignal,
): Promise<BackendProbeResponse> {
  return request_json("/api/health", { method: "POST", signal });
}

export function get_health(signal?: AbortSignal): Promise<HealthResponse> {
  return request_json("/api/health", { signal });
}
