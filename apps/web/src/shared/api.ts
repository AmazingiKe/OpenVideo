import type {
  AgentJob,
  AgentQuestionAction,
  AnalysisJob,
  AnalysisStrategy,
  AnalysisStrategyPresetDescriptor,
  AiModelConfiguration,
  AiModelSummary,
  AiModelTestResult,
  AnalysisMode,
  AnalysisPageSettings,
  DownloadAccount,
  DownloadCookieBrowser,
  DownloadJob,
  HealthResponse,
  LibraryDescription,
  MediaAsset,
  MediaMarker,
  MediaSegment,
  ProbeResponse,
  Transcript,
  TranscriptionOptions,
  TranscriptionModelDescriptor,
  TranscriptionModelDownloadJob,
  Preferences,
  SummaryAgentRun,
  SummaryConversation,
  SummaryConversationState,
  SummaryDetail,
  SummaryDocument,
  SummaryExportResult,
  SummaryEditProposal,
  SummaryMediaArtifact,
  SourcePlatform,
  SummaryMediaSuggestion,
} from "./types";

const api_base_url = import.meta.env.VITE_API_BASE_URL ?? "";
const SUMMARY_DOCUMENTS_EVENT = "documents";

const DEFAULT_ANALYSIS_STRATEGY: AnalysisStrategy = {
  preset: "course_notes",
  weights: {
    core_concepts: 90,
    formula_derivation: 65,
    case_demonstration: 60,
    questions_conclusions: 80,
    visual_content: 55,
    user_markers: 100,
  },
  depth: "balanced",
  marker_context_seconds: 30,
};

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

export function get_analysis_page_settings(
  signal?: AbortSignal,
): Promise<AnalysisPageSettings> {
  return request_json("/api/page-settings/analysis", { signal });
}

export function update_analysis_page_settings(
  settings: AnalysisPageSettings,
  signal?: AbortSignal,
): Promise<AnalysisPageSettings> {
  return request_json("/api/page-settings/analysis", {
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

export function create_transcript_correction(
  asset_id: string,
  segment_indices: number[] | null,
  ai_model_id: string,
  signal?: AbortSignal,
): Promise<AgentJob> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/transcript/corrections`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segment_indices, ai_model_id }),
      signal,
    },
  );
}

export function get_agent_job(
  job_id: string,
  signal?: AbortSignal,
): Promise<AgentJob> {
  return request_json(`/api/agent-jobs/${encodeURIComponent(job_id)}`, {
    signal,
  });
}

export function list_asset_agent_jobs(
  asset_id: string,
  active: boolean,
  signal?: AbortSignal,
): Promise<AgentJob[]> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/agent-jobs?active=${active}`,
    { signal },
  );
}

export function respond_to_agent_job(
  job_id: string,
  question_id: string,
  action: AgentQuestionAction,
  ai_model_id: string | null,
  signal?: AbortSignal,
): Promise<AgentJob> {
  return request_json(
    `/api/agent-jobs/${encodeURIComponent(job_id)}/responses`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question_id, action, ai_model_id }),
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

export function list_summary_conversations(
  asset_id: string,
  signal?: AbortSignal,
): Promise<SummaryConversation[]> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/summary-conversations`,
    { signal },
  );
}

export function create_summary_conversation(
  asset_id: string,
  document_id: string,
  signal?: AbortSignal,
): Promise<SummaryConversationState> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/summary-conversations`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document_id }),
      signal,
    },
  );
}

export function get_summary_conversation(
  conversation_id: string,
  signal?: AbortSignal,
): Promise<SummaryConversationState> {
  return request_json(
    `/api/summary-conversations/${encodeURIComponent(conversation_id)}`,
    { signal },
  );
}

export async function delete_summary_conversation(
  conversation_id: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${api_base_url}/api/summary-conversations/${encodeURIComponent(conversation_id)}`,
    { method: "DELETE", signal },
  );
  if (!response.ok)
    throw new ApiError(`请求失败（${response.status}）`, response.status);
}

export function create_summary_agent_run(
  conversation_id: string,
  request: {
    document_id: string;
    expected_revision: number;
    instruction: string;
    ai_model_id: string;
    selection: { start: number; end: number; text: string } | null;
  },
  signal?: AbortSignal,
): Promise<SummaryAgentRun> {
  return request_json(
    `/api/summary-conversations/${encodeURIComponent(conversation_id)}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    },
  );
}

export type SummaryAgentEvent =
  | { event: "status"; data: { stage: SummaryAgentRun["stage"] } }
  | { event: "reply"; data: SummaryConversationState["messages"][number] }
  | { event: "proposal"; data: SummaryEditProposal }
  | { event: "complete"; data: { run_id: string } }
  | { event: "error"; data: { run_id: string; message: string } };

export async function stream_summary_agent_run(
  run_id: string,
  on_event: (event: SummaryAgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${api_base_url}/api/summary-agent-runs/${encodeURIComponent(run_id)}/events`,
    { signal },
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
          event: event_name,
          data: JSON.parse(data),
        } as SummaryAgentEvent);
      }
    }
    if (done) break;
  }
}

export function resolve_summary_proposal(
  proposal_id: string,
  action: "accept" | "reject",
  signal?: AbortSignal,
): Promise<SummaryEditProposal> {
  return request_json(
    `/api/summary-edit-proposals/${encodeURIComponent(proposal_id)}/${action}`,
    { method: "POST", signal },
  );
}

export function create_summary_media(
  document: SummaryDocument,
  suggestion: SummaryMediaSuggestion,
  signal?: AbortSignal,
): Promise<{ artifact: SummaryMediaArtifact; document: SummaryDocument }> {
  return request_json("/api/summary-media", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      document_id: document.document_id,
      expected_revision: document.revision,
      media_type: suggestion.media_type,
      start_seconds: suggestion.start_seconds,
      end_seconds: suggestion.end_seconds,
      insert_after: suggestion.insert_after,
      caption: suggestion.caption,
    }),
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
