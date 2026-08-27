import type {
  AiModelConfiguration,
  AiModelSummary,
  AiModelTestResult,
  MarkersPageSettings,
  Preferences,
  TranscriptionModelDescriptor,
  TranscriptionModelDownloadJob,
} from "../types";
import { request_json } from "./client";

export function get_preferences(signal?: AbortSignal): Promise<Preferences> {
  return request_json("/api/preferences", { signal });
}

export function list_transcription_models(
  signal?: AbortSignal,
): Promise<TranscriptionModelDescriptor[]> {
  return request_json("/api/transcription/models", { signal });
}

export function download_transcription_model(
  engine: TranscriptionModelDescriptor["engine"],
  model: string,
  signal?: AbortSignal,
): Promise<TranscriptionModelDownloadJob> {
  return request_json(
    `/api/transcription/models/${encodeURIComponent(engine)}/${encodeURIComponent(model)}/downloads`,
    { method: "POST", signal },
  );
}

export function get_transcription_model_download(
  job_id: string,
  signal?: AbortSignal,
): Promise<TranscriptionModelDownloadJob> {
  return request_json(
    `/api/transcription/model-downloads/${encodeURIComponent(job_id)}`,
    { signal },
  );
}

export function list_ai_models(
  signal?: AbortSignal,
): Promise<AiModelSummary[]> {
  return request_json("/api/ai/models", { signal });
}

export function test_ai_model(
  model: AiModelConfiguration,
  signal?: AbortSignal,
): Promise<AiModelTestResult> {
  return request_json("/api/ai/models/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(model),
    signal,
  });
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

export function get_markers_page_settings(
  signal?: AbortSignal,
): Promise<MarkersPageSettings> {
  return request_json("/api/page-settings/markers", { signal });
}

export function update_markers_page_settings(
  settings: MarkersPageSettings,
  signal?: AbortSignal,
): Promise<MarkersPageSettings> {
  return request_json("/api/page-settings/markers", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
    signal,
  });
}
