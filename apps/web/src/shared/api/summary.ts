import type {
  SummaryDetail,
  SummaryDocument,
  SummaryExportResult,
  SummaryGenerationResult,
  SummaryPreset,
  SummaryVersion,
} from "../types";
import { api_base_url, ApiError, request_json } from "./client";

const SUMMARY_DOCUMENTS_EVENT = "documents";

export function list_summary_documents(
  asset_id: string,
  version_id?: string | null,
  signal?: AbortSignal,
): Promise<SummaryDocument[]> {
  const query = version_id
    ? `?version_id=${encodeURIComponent(version_id)}`
    : "";
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/summary-documents${query}`,
    { signal },
  );
}

export function list_summary_presets(
  signal?: AbortSignal,
): Promise<SummaryPreset[]> {
  return request_json("/api/summary-presets", { signal });
}

export function list_summary_versions(
  asset_id: string,
  signal?: AbortSignal,
): Promise<SummaryVersion[]> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/summary-versions`,
    { signal },
  );
}

export function select_summary_version(
  asset_id: string,
  version_id: string,
  signal?: AbortSignal,
): Promise<SummaryVersion> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/summary-current-version`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version_id }),
      signal,
    },
  );
}

export function subscribe_summary_documents(
  asset_id: string,
  on_documents: (documents: SummaryDocument[]) => void,
): () => void {
  if (typeof EventSource === "undefined") return () => undefined;
  const event_source = new EventSource(
    `${api_base_url}/api/media/assets/${encodeURIComponent(asset_id)}/summary-documents/events`,
  );
  const handle_documents = (event: MessageEvent<string>) => {
    on_documents(JSON.parse(event.data) as SummaryDocument[]);
  };
  event_source.addEventListener(SUMMARY_DOCUMENTS_EVENT, handle_documents);
  return () => {
    event_source.removeEventListener(SUMMARY_DOCUMENTS_EVENT, handle_documents);
    event_source.close();
  };
}

export function generate_summary_documents(
  asset_id: string,
  options: {
    ai_model_id: string;
    preset_id: string;
    user_input: string | null;
    detail: SummaryDetail;
    output_language: string;
  },
  signal?: AbortSignal,
): Promise<SummaryGenerationResult> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/summary-documents/generate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
      signal,
    },
  );
}

export function create_summary_child(
  parent_document_id: string,
  title: string,
  signal?: AbortSignal,
): Promise<SummaryDocument> {
  return request_json(
    `/api/summary-documents/${encodeURIComponent(parent_document_id)}/children`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, markdown: "" }),
      signal,
    },
  );
}

export function duplicate_summary_document(
  document_id: string,
  signal?: AbortSignal,
): Promise<SummaryDocument> {
  return request_json(
    `/api/summary-documents/${encodeURIComponent(document_id)}/duplicate`,
    { method: "POST", signal },
  );
}

export function move_summary_document(
  document_id: string,
  parent_document_id: string,
  position: number,
  signal?: AbortSignal,
): Promise<SummaryDocument[]> {
  return request_json(
    `/api/summary-documents/${encodeURIComponent(document_id)}/move`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent_document_id, position }),
      signal,
    },
  );
}

export function update_summary_document(
  document_id: string,
  expected_revision: number,
  patch: { title?: string; markdown?: string; position?: number },
  signal?: AbortSignal,
): Promise<SummaryDocument> {
  return request_json(
    `/api/summary-documents/${encodeURIComponent(document_id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected_revision, ...patch }),
      signal,
    },
  );
}

export async function delete_summary_document(
  document_id: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${api_base_url}/api/summary-documents/${encodeURIComponent(document_id)}`,
    { method: "DELETE", signal },
  );
  if (!response.ok)
    throw new ApiError(`请求失败（${response.status}）`, response.status);
}

export function create_summary_export(
  asset_id: string,
  version_id: string,
  signal?: AbortSignal,
): Promise<SummaryExportResult> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/summary-exports?version_id=${encodeURIComponent(version_id)}`,
    { method: "POST", signal },
  );
}
