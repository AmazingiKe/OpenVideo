import type { SubtitleDisplaySettings, SubtitleExportResult } from "../types";
import { api_base_url, request_json } from "./client";

export function media_url(path: string): string;
export function media_url(path: string | null | undefined): string | undefined;
export function media_url(path: string | null | undefined): string | undefined {
  return path ? `${api_base_url}${path}` : undefined;
}

export function update_subtitle_settings(
  asset_id: string,
  settings: SubtitleDisplaySettings,
  signal?: AbortSignal,
): Promise<SubtitleDisplaySettings> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/subtitle-settings`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
      signal,
    },
  );
}

export function create_subtitle_export(
  asset_id: string,
  signal?: AbortSignal,
): Promise<SubtitleExportResult> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/subtitle-exports`,
    { method: "POST", signal },
  );
}
