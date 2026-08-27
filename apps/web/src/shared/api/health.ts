import type { HealthResponse } from "../types";
import { request_json } from "./client";

export function get_health(signal?: AbortSignal): Promise<HealthResponse> {
  return request_json("/api/health", { signal });
}
