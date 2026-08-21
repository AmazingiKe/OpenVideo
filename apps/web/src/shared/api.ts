import type {
  AnalysisJob,
  AnalysisMode,
  DownloadJob,
  HealthResponse,
  LibraryDescription,
  MediaAsset,
  MediaMarker,
  MediaSegment,
  ProbeResponse,
  Transcript,
  Preferences,
} from "./types";

const api_base_url = import.meta.env.VITE_API_BASE_URL ?? "";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request_json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${api_base_url}${path}`, init);
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const payload = (await response.json()) as {
        detail?: string;
        message?: string;
      };
      if (payload.message) message = payload.message;
      else if (payload.detail) message = payload.detail;
    } catch {
      // 非 JSON 错误仍保留状态码，避免解析失败掩盖真实请求错误。
    }
    throw new ApiError(message, response.status);
  }
  return (await response.json()) as T;
}

export function get_library(
  signal?: AbortSignal,
): Promise<LibraryDescription | null> {
  return request_json("/api/library", { signal });
}

export function create_library(
  path: string,
  signal?: AbortSignal,
): Promise<LibraryDescription> {
  return request_json("/api/library/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
    signal,
  });
}

export function open_library(
  path: string,
  signal?: AbortSignal,
): Promise<LibraryDescription> {
  return request_json("/api/library/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
    signal,
  });
}

export async function select_library_directory(
  signal?: AbortSignal,
): Promise<string | null> {
  const selection = await request_json<{ path: string | null }>(
    "/api/library/select-directory",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal,
    },
  );
  return selection.path;
}

export async function close_library(signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${api_base_url}/api/library`, {
    method: "DELETE",
    signal,
  });
  if (!response.ok)
    throw new ApiError(`请求失败（${response.status}）`, response.status);
}

export function get_preferences(signal?: AbortSignal): Promise<Preferences> {
  return request_json("/api/preferences", { signal });
}

export function update_preferences(
  preferences: Partial<
    Omit<Preferences, "managed_fields" | "library_path_managed">
  >,
  signal?: AbortSignal,
): Promise<Preferences> {
  return request_json("/api/preferences", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(preferences),
    signal,
  });
}

export function get_health(signal?: AbortSignal): Promise<HealthResponse> {
  return request_json("/api/health", { signal });
}

export function probe_source(
  source_url: string,
  signal?: AbortSignal,
): Promise<ProbeResponse> {
  return request_json("/api/downloads/probe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_url }),
    signal,
  });
}

export function create_download(
  source_urls: string[],
  signal?: AbortSignal,
): Promise<DownloadJob[]> {
  return request_json("/api/downloads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_urls }),
    signal,
  });
}

export function get_download(
  job_id: string,
  signal?: AbortSignal,
): Promise<DownloadJob> {
  return request_json(`/api/downloads/${encodeURIComponent(job_id)}`, {
    signal,
  });
}

export function list_assets(signal?: AbortSignal): Promise<MediaAsset[]> {
  return request_json("/api/media/assets", { signal });
}

export function analyze_asset(
  asset_id: string,
  mode: AnalysisMode,
  marker_ids: string[],
  signal?: AbortSignal,
): Promise<AnalysisJob> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/analyze`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, marker_ids, force: true }),
      signal,
    },
  );
}

export function transcribe_asset(
  asset_id: string,
  signal?: AbortSignal,
): Promise<AnalysisJob> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/transcribe`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: false }),
      signal,
    },
  );
}

export function get_analysis(
  job_id: string,
  signal?: AbortSignal,
): Promise<AnalysisJob> {
  return request_json(`/api/analysis/${encodeURIComponent(job_id)}`, {
    signal,
  });
}

export function get_transcript(
  asset_id: string,
  signal?: AbortSignal,
): Promise<Transcript> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/transcript`,
    { signal },
  );
}

export function update_transcript_segment(
  asset_id: string,
  segment_index: number,
  text: string,
  signal?: AbortSignal,
): Promise<Transcript> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/transcript/segments/${segment_index}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    },
  );
}

export function get_segments(
  asset_id: string,
  signal?: AbortSignal,
): Promise<MediaSegment[]> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/segments`,
    { signal },
  );
}

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
  time_seconds: number,
  tags: string[],
  signal?: AbortSignal,
): Promise<MediaMarker> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/markers`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ time_seconds, tags }),
      signal,
    },
  );
}

export function update_marker(
  asset_id: string,
  marker_id: string,
  tags: string[],
  signal?: AbortSignal,
): Promise<MediaMarker> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/markers/${encodeURIComponent(marker_id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags }),
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

export function media_url(path: string): string;
export function media_url(path: string | null | undefined): string | undefined;
export function media_url(path: string | null | undefined): string | undefined {
  return path ? `${api_base_url}${path}` : undefined;
}
