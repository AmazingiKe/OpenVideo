import type {
  SummaryDetail,
  SummaryDocument,
  SummaryExportResult,
} from "../types";
import { api_base_url, ApiError, request_json } from "./client";

const SUMMARY_DOCUMENTS_EVENT = "documents";

export function list_summary_documents(
  asset_id: string,
  signal?: AbortSignal,
): Promise<SummaryDocument[]> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/summary-documents`,
    { signal },
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
    ai_model_id: string | null;
    detail: SummaryDetail;
    create_subdocuments: boolean;
    subdocument_mode: "chapters";
  },
  signal?: AbortSignal,
): Promise<SummaryDocument[]> {
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
  root_document_id: string,
  title: string,
  signal?: AbortSignal,
): Promise<SummaryDocument> {
  return request_json(
    `/api/summary-documents/${encodeURIComponent(root_document_id)}/children`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, markdown: "" }),
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

export function reorder_summary_children(
  root_document_id: string,
  document_ids: string[],
  signal?: AbortSignal,
): Promise<SummaryDocument[]> {
  return request_json(
    `/api/summary-documents/${encodeURIComponent(root_document_id)}/children/order`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document_ids }),
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
  signal?: AbortSignal,
): Promise<SummaryExportResult> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/summary-exports`,
    { method: "POST", signal },
  );
}
