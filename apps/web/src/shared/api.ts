import type {
  AnalysisJob,
  AnalysisStrategy,
  AnalysisStrategyPresetDescriptor,
  AiModelConfiguration,
  AiModelSummary,
  AiModelTestResult,
  AnalysisMode,
  MarkersPageSettings,
  DownloadAccount,
  DownloadAccountLoginSession,
  DownloadCookieBrowser,
  DownloadDestination,
  DownloadJob,
  HealthResponse,
  LibraryDescription,
  MediaAsset,
  LibraryFolder,
  MediaMarker,
  MediaMarkerCreate,
  MediaMarkerUpdate,
  MediaSegment,
  ProbeResponse,
  Transcript,
  TranscriptionOptions,
  TranscriptionModelDescriptor,
  TranscriptionModelDownloadJob,
  Preferences,
  AgentRun,
  AgentArtifact,
  AgentDefinitionAvailability,
  AgentEventType,
  AgentSession,
  AgentSessionState,
  SummaryDetail,
  SummaryDocument,
  SummaryExportResult,
  SourcePlatform,
} from "./types";
import { DEFAULT_ANALYSIS_STRATEGY } from "./analysis";

const api_base_url = import.meta.env.VITE_API_BASE_URL ?? "";
const SUMMARY_DOCUMENTS_EVENT = "documents";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function list_agent_definitions(
  signal?: AbortSignal,
): Promise<AgentDefinitionAvailability[]> {
  return request_json("/api/agent-definitions", { signal });
}

export function list_agent_sessions(
  filters: { agent_id?: string; asset_id?: string },
  signal?: AbortSignal,
): Promise<AgentSession[]> {
  const query = new URLSearchParams();
  if (filters.agent_id) query.set("agent_id", filters.agent_id);
  if (filters.asset_id) query.set("asset_id", filters.asset_id);
  return request_json(`/api/agent-sessions?${query.toString()}`, { signal });
}

export function create_agent_session(
  request: {
    agent_id: string;
    asset_id: string;
    title?: string;
    context?: Record<string, unknown>;
  },
  signal?: AbortSignal,
): Promise<AgentSession> {
  return request_json("/api/agent-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
}

export function get_agent_session(
  session_id: string,
  signal?: AbortSignal,
): Promise<AgentSessionState> {
  return request_json(`/api/agent-sessions/${encodeURIComponent(session_id)}`, {
    signal,
  });
}

export function create_agent_run(
  session_id: string,
  request: {
    request_key: string;
    ai_model_id: string;
    content?: string;
    task_input?: Record<string, unknown>;
  },
  signal?: AbortSignal,
): Promise<AgentRun> {
  return request_json(
    `/api/agent-sessions/${encodeURIComponent(session_id)}/runs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    },
  );
}

export function get_agent_run(
  run_id: string,
  signal?: AbortSignal,
): Promise<AgentRun> {
  return request_json(`/api/agent-runs/${encodeURIComponent(run_id)}`, {
    signal,
  });
}

export type UnifiedAgentRunEvent = {
  event: AgentEventType;
  data: {
    event_id: string;
    sequence: number;
    [key: string]: unknown;
  };
};

export async function stream_unified_agent_run(
  run_id: string,
  on_event: (event: UnifiedAgentRunEvent) => void,
  signal?: AbortSignal,
  last_sequence = 0,
): Promise<void> {
  const response = await fetch(
    `${api_base_url}/api/agent-runs/${encodeURIComponent(run_id)}/events`,
    {
      signal,
      headers:
        last_sequence > 0
          ? { "Last-Event-ID": String(last_sequence) }
          : undefined,
    },
  );
  if (!response.ok || !response.body) {
    throw new ApiError(`请求失败（${response.status}）`, response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const event_name = block.match(/^event: (.+)$/m)?.[1];
      const data = block.match(/^data: (.+)$/m)?.[1];
      if (event_name && data) {
        on_event({
          event: event_name as AgentEventType,
          data: JSON.parse(data),
        });
      }
    }
    if (done) break;
  }
}

export function resolve_agent_artifact(
  artifact_id: string,
  action: "approve" | "reject",
  signal?: AbortSignal,
): Promise<AgentArtifact> {
  return request_json(
    `/api/agent-artifacts/${encodeURIComponent(artifact_id)}/${action}`,
    { method: "POST", signal },
  );
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

export async function select_directory(
  signal?: AbortSignal,
): Promise<string | null> {
  const selection = await request_json<{ path: string | null }>(
    "/api/directories/select",
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

export function get_health(signal?: AbortSignal): Promise<HealthResponse> {
  return request_json("/api/health", { signal });
}

export function get_download_accounts(
  signal?: AbortSignal,
): Promise<DownloadAccount[]> {
  return request_json("/api/download-accounts", { signal });
}

export function create_download_account_login_session(
  platform: SourcePlatform,
  signal?: AbortSignal,
): Promise<DownloadAccountLoginSession> {
  return request_json(`/api/download-accounts/${platform}/login-sessions`, {
    method: "POST",
    signal,
  });
}

export function get_download_account_login_session(
  login_id: string,
  signal?: AbortSignal,
): Promise<DownloadAccountLoginSession> {
  return request_json(
    `/api/download-account-login-sessions/${encodeURIComponent(login_id)}`,
    { signal },
  );
}

export async function delete_download_account_login_session(
  login_id: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${api_base_url}/api/download-account-login-sessions/${encodeURIComponent(login_id)}`,
    { method: "DELETE", signal },
  );
  if (!response.ok)
    throw new ApiError(`请求失败（${response.status}）`, response.status);
}

export function save_download_account(
  platform: SourcePlatform,
  cookie: string,
  signal?: AbortSignal,
): Promise<DownloadAccount> {
  return request_json(`/api/download-accounts/${platform}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cookie }),
    signal,
  });
}

export function import_download_account_from_browser(
  platform: SourcePlatform,
  browser: DownloadCookieBrowser,
  source_url?: string,
  signal?: AbortSignal,
): Promise<DownloadAccount> {
  return request_json(`/api/download-accounts/${platform}/import-browser`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ browser, source_url: source_url || null }),
    signal,
  });
}

export function test_download_account(
  platform: SourcePlatform,
  source_url?: string,
  signal?: AbortSignal,
): Promise<DownloadAccount> {
  return request_json(`/api/download-accounts/${platform}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_url: source_url || null }),
    signal,
  });
}

export async function delete_download_account(
  platform: SourcePlatform,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${api_base_url}/api/download-accounts/${platform}`,
    {
      method: "DELETE",
      signal,
    },
  );
  if (!response.ok)
    throw new ApiError(`请求失败（${response.status}）`, response.status);
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
  destination: DownloadDestination = {
    video_quality: "best",
    folder_id: null,
    automatic_folder_name: null,
    assign_folder: false,
  },
): Promise<DownloadJob[]> {
  return request_json("/api/downloads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_urls, ...destination }),
    signal,
  });
}

export function list_downloads(
  limit: number,
  signal?: AbortSignal,
): Promise<DownloadJob[]> {
  const parameters = new URLSearchParams({ limit: limit.toString() });
  return request_json(`/api/downloads?${parameters}`, { signal });
}

export function get_download(
  job_id: string,
  signal?: AbortSignal,
): Promise<DownloadJob> {
  return request_json(`/api/downloads/${encodeURIComponent(job_id)}`, {
    signal,
  });
}

export function request_download_retry(
  job_id: string,
  signal?: AbortSignal,
): Promise<DownloadJob> {
  return request_json(`/api/downloads/${encodeURIComponent(job_id)}/retry`, {
    method: "POST",
    signal,
  });
}

export function list_assets(
  signal?: AbortSignal,
  options?: {
    folder_id?: string;
    uncategorized?: boolean;
    search?: string;
    sort_by?: "created_at" | "title" | "duration";
    sort_order?: "asc" | "desc";
  },
): Promise<MediaAsset[]> {
  const parameters = new URLSearchParams();
  if (options?.folder_id) parameters.set("folder_id", options.folder_id);
  if (options?.uncategorized) parameters.set("uncategorized", "true");
  if (options?.search) parameters.set("search", options.search);
  if (options?.sort_by) parameters.set("sort_by", options.sort_by);
  if (options?.sort_order) parameters.set("sort_order", options.sort_order);
  const query = parameters.size ? `?${parameters.toString()}` : "";
  return request_json(`/api/media/assets${query}`, { signal });
}

export function list_folders(signal?: AbortSignal): Promise<LibraryFolder[]> {
  return request_json("/api/library/folders", { signal });
}

export function create_folder(
  name: string,
  parent_id: string | null,
  signal?: AbortSignal,
): Promise<LibraryFolder> {
  return request_json("/api/library/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, parent_id }),
    signal,
  });
}

export function rename_folder(
  folder_id: string,
  name: string,
  signal?: AbortSignal,
): Promise<LibraryFolder> {
  return request_json(`/api/library/folders/${encodeURIComponent(folder_id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
    signal,
  });
}

export function move_folder(
  folder_id: string,
  parent_id: string | null,
  signal?: AbortSignal,
): Promise<LibraryFolder> {
  return request_json(
    `/api/library/folders/${encodeURIComponent(folder_id)}/parent`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent_id }),
      signal,
    },
  );
}

export function move_assets(
  asset_ids: string[],
  folder_id: string | null,
  signal?: AbortSignal,
): Promise<MediaAsset[]> {
  return request_json("/api/media/assets/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ asset_ids, folder_id }),
    signal,
  });
}

export async function delete_asset(
  asset_id: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${api_base_url}/api/media/assets/${encodeURIComponent(asset_id)}`,
    { method: "DELETE", signal },
  );
  if (!response.ok) {
    throw new ApiError(`请求失败（${response.status}）`, response.status);
  }
}

export async function delete_folder(
  folder_id: string,
  confirmation_name: string | null,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${api_base_url}/api/library/folders/${encodeURIComponent(folder_id)}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation_name }),
      signal,
    },
  );
  if (!response.ok) {
    throw new ApiError(`请求失败（${response.status}）`, response.status);
  }
}

export function analyze_asset(
  asset_id: string,
  mode: AnalysisMode,
  marker_ids: string[],
  ai_model_id: string | null,
  strategy: AnalysisStrategy = DEFAULT_ANALYSIS_STRATEGY,
  signal?: AbortSignal,
): Promise<AnalysisJob> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/analyze`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        marker_ids,
        ai_model_id,
        strategy,
        force: true,
      }),
      signal,
    },
  );
}

export function list_analysis_strategies(
  signal?: AbortSignal,
): Promise<AnalysisStrategyPresetDescriptor[]> {
  return request_json("/api/analysis-strategies", { signal });
}

export function transcribe_asset(
  asset_id: string,
  options: TranscriptionOptions,
  signal?: AbortSignal,
): Promise<AnalysisJob> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/transcribe`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true, ...options }),
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

export function resolve_analysis_proposal(
  job_id: string,
  action: "approve" | "reject",
  signal?: AbortSignal,
): Promise<AnalysisJob> {
  return request_json(`/api/analysis/${encodeURIComponent(job_id)}/${action}`, {
    method: "POST",
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

export function media_url(path: string): string;
export function media_url(path: string | null | undefined): string | undefined;
export function media_url(path: string | null | undefined): string | undefined {
  return path ? `${api_base_url}${path}` : undefined;
}

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

export function cancel_agent_run(
  run_id: string,
  signal?: AbortSignal,
): Promise<AgentRun> {
  return request_json(`/api/agent-runs/${encodeURIComponent(run_id)}/cancel`, {
    method: "POST",
    signal,
  });
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
