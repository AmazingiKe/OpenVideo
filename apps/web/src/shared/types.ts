type DependencyStatus = {
  yt_dlp: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
};

export type SourcePlatform = "bilibili" | "douyin" | "youtube";

export type DownloadAccount = {
  account_id: string;
  platform: SourcePlatform;
  display_name: string;
  status: "untested" | "available" | "expired";
  last_tested_at: string | null;
  updated_at: string;
};

export type DownloadCookieBrowser = "edge" | "chrome" | "firefox";

export type DownloadAccountLoginSession = {
  login_id: string;
  platform: SourcePlatform;
  stage: "waiting" | "complete" | "failed" | "cancelled";
  message: string;
  account: DownloadAccount | null;
};

export type ProbeEntry = {
  source_video_id: string;
  url: string;
  title: string | null;
  duration_seconds: number | null;
  uploader: string | null;
};

export type ProbeResponse = {
  platform: SourcePlatform;
  is_playlist: boolean;
  title: string | null;
  entries: ProbeEntry[];
  truncated: boolean;
  total_count: number;
};

export type HealthResponse = {
  status: "ready" | "degraded";
  dependencies: DependencyStatus;
};

export type LibraryDescription = {
  library_id: string;
  name: string;
  root_path: string;
  format_version: number;
  created_at: string;
  index_issues: LibraryIndexIssue[];
};

export type LibraryIndexIssue = {
  asset_id: string | null;
  relative_path: string;
  code: string;
  message: string;
};

export type Preferences = {
  tools_directory: string | null;
  models_directory: string | null;
  default_transcription: TranscriptionOptions;
  ai_models: AiModelConfiguration[];
  managed_fields: string[];
  library_path_managed: boolean;
};

export const AI_INPUT_MODALITIES = ["text", "image", "audio", "video"] as const;

export type AiInputModality = (typeof AI_INPUT_MODALITIES)[number];
export const IMAGE_INPUT_MODALITY: AiInputModality = "image";

export type AiModelSummary = {
  model_id: string;
  name: string;
  litellm_model: string;
  tool_calling_mode: "auto" | "enabled" | "disabled";
  input_modalities: AiInputModality[];
};

export type AiModelConfiguration = AiModelSummary & {
  api_key: string | null;
  api_base: string | null;
  api_version: string | null;
};

export type AiModelTestResult = {
  available: boolean;
  latency_ms: number;
  message: string;
};

export type AnalysisToolSection =
  "video_information" | "transcription" | "transcript_correction" | "analysis";

export type TranscriptCorrectionScope = "all" | "selection";

export type AgentExecutionMode = "automatic" | "chunked" | "compressed";
export type AgentStage =
  | "pending"
  | "preparing"
  | "invoking_model"
  | "validating"
  | "waiting_for_input"
  | "applying"
  | "complete"
  | "failed"
  | "cancelled";
export type AgentQuestionAction =
  "change_model" | "chunk" | "compress" | "rerun_latest" | "cancel";
export type AgentQuestion = {
  question_id: string;
  question_type: "context_limit" | "transcript_changed";
  message: string;
  actions: AgentQuestionAction[];
};
export type AgentJob = {
  job_id: string;
  asset_id: string;
  agent_type: "transcript_correction";
  execution_mode: AgentExecutionMode;
  stage: AgentStage;
  progress_percent: number;
  message: string;
  ai_model_id: string;
  segment_indices: number[] | null;
  transcript_checksum: string;
  question: AgentQuestion | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type MarkersPageSettings = {
  asset_library_size_percent: number;
  agent_panel_size_percent: number;
  asset_library_collapsed: boolean;
  left_panel_tab: "video" | "agent";
  tool_panel_size_percent: number;
  tool_panel_collapsed: boolean;
  open_tool_sections: AnalysisToolSection[];
};

type DownloadStage =
  | "pending"
  | "reading_metadata"
  | "downloading"
  | "processing"
  | "complete"
  | "failed";

export type DownloadJob = {
  job_id: string;
  asset_id: string;
  stage: DownloadStage;
  progress_percent: number;
  message: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

type AnalysisStage =
  | "pending"
  | "extracting_audio"
  | "transcribing"
  | "building_timeline"
  | "extracting_frames"
  | "describing_visuals"
  | "complete"
  | "failed";

export type AnalysisMode = "full" | "markers";
export type AnalysisStrategyPreset =
  | "course_notes"
  | "formula_derivation"
  | "operation_tutorial"
  | "case_review"
  | "custom";
export type AnalysisDepth = "quick" | "balanced" | "deep";
export type AnalysisWeights = {
  core_concepts: number;
  formula_derivation: number;
  case_demonstration: number;
  questions_conclusions: number;
  visual_content: number;
  user_markers: number;
};
export type AnalysisStrategy = {
  preset: AnalysisStrategyPreset;
  weights: AnalysisWeights;
  depth: AnalysisDepth;
  marker_range_before_seconds: number;
  marker_range_after_seconds: number;
};
export type AnalysisStrategyPresetDescriptor = {
  preset: Exclude<AnalysisStrategyPreset, "custom">;
  name: string;
  description: string;
  strategy: AnalysisStrategy;
};
export type AnalysisOperation = "transcription" | "analysis";
export type TranscriptionEngine = "faster-whisper" | "qwen3-asr" | "sensevoice";
export type TranscriptionDevice = "auto" | "cpu" | "cuda";
export type TranscriptionComputeType = "auto" | "int8" | "float16";
export type TranscriptionIntegrationStatus = "available" | "adapter_required";
export type TranscriptionModelInstallationStatus =
  "not_installed" | "downloading" | "installed" | "failed";
export type TranscriptionModelDownloadStage =
  "pending" | "resolving" | "downloading" | "complete" | "failed";
export type TranscriptionModelDownloadJob = {
  job_id: string;
  engine: TranscriptionEngine;
  model: string;
  stage: TranscriptionModelDownloadStage;
  progress_percent: number;
  downloaded_bytes: number;
  total_bytes: number | null;
  message: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};
export type TranscriptionOptions = {
  engine: TranscriptionEngine;
  model: string;
  language: string | null;
  device: TranscriptionDevice;
  compute_type: TranscriptionComputeType;
};
export type TranscriptionModelDescriptor = {
  engine: TranscriptionEngine;
  model: string;
  name: string;
  description: string;
  accuracy: string;
  speed: string;
  languages: string[];
  repository: string;
  recommended: boolean;
  integration_status: TranscriptionIntegrationStatus;
  installation_status: TranscriptionModelInstallationStatus;
  download_job: TranscriptionModelDownloadJob | null;
};
type AnalysisCapability = "transcript" | "timeline" | "visual";

export type AnalysisJob = {
  job_id: string;
  asset_id: string;
  operation: AnalysisOperation;
  mode: AnalysisMode;
  marker_ids: string[];
  ai_model_id: string | null;
  strategy: AnalysisStrategy;
  capabilities: AnalysisCapability[];
  stage: AnalysisStage;
  progress_percent: number;
  message: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type TranscriptSegment = {
  start_seconds: number;
  end_seconds: number;
  text: string;
  emotion:
    | "happy"
    | "sad"
    | "angry"
    | "neutral"
    | "fearful"
    | "disgusted"
    | "surprised"
    | "unknown"
    | null;
  audio_events: (
    | "bgm"
    | "speech"
    | "applause"
    | "laughter"
    | "cry"
    | "sneeze"
    | "breath"
    | "cough"
    | "singing"
    | "speech_noise"
    | "unknown"
  )[];
};

export type Transcript = {
  asset_id: string;
  language: string | null;
  segments: TranscriptSegment[];
  created_at: string;
};

export type MediaSegment = {
  segment_id: string;
  asset_id: string;
  start_seconds: number;
  end_seconds: number;
  title: string;
  detailed_summary: string | null;
  transcript_text: string | null;
  speaker_name: string | null;
  key_frame_paths: string[];
  visual_description: string | null;
  ocr_text: string | null;
  marker_ids: string[];
  tags: string[];
};

export type MediaMarker = {
  marker_id: string;
  asset_id: string;
  start_seconds: number;
  end_seconds: number | null;
  title: string;
  tags: string[];
  marker_range_before_seconds: number | null;
  marker_range_after_seconds: number | null;
};

export type MediaMarkerInput = Pick<
  MediaMarker,
  | "start_seconds"
  | "end_seconds"
  | "title"
  | "tags"
  | "marker_range_before_seconds"
  | "marker_range_after_seconds"
>;

type ThumbnailStoryboard = {
  url: string;
  tile_width: number;
  tile_height: number;
  tiles: { start_time: number; x: number; y: number }[];
};

export type MediaAsset = {
  asset_id: string;
  media_type: "video" | "image";
  source_url: string;
  source_platform: SourcePlatform;
  source_video_id: string | null;
  title: string;
  author_name: string | null;
  description: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  status: "pending" | "downloading" | "processing" | "ready" | "failed";
  error_message: string | null;
  playback_url: string | null;
  thumbnail_url: string | null;
  thumbnail_storyboard: ThumbnailStoryboard | null;
  created_at: string;
  updated_at: string;
};

export type SummaryDetail = "concise" | "standard" | "detailed";
export type SummaryDocument = {
  document_id: string;
  asset_id: string;
  parent_document_id: string | null;
  title: string;
  markdown: string;
  relative_path: string;
  content_digest: string;
  position: number;
  revision: number;
  created_at: string;
  updated_at: string;
};
export type SummaryExportResult = {
  export_id: string;
  relative_path: string;
  file_name: string;
  size_bytes: number;
  exported_at: string;
};
export type AgentSession = {
  session_id: string;
  agent_type: string;
  title: string;
  created_at: string;
  updated_at: string;
};
export type AgentEventType =
  | "turn/start"
  | "turn/end"
  | "step/start"
  | "step/end"
  | "user/message"
  | "assistant/chunk"
  | "assistant/message"
  | "tool/call"
  | "tool/result"
  | "run/status"
  | "archive/message";
export type AgentEvent = {
  event_id: string;
  session_id: string;
  sequence: number;
  run_id: string | null;
  event_type: AgentEventType;
  payload: Record<string, unknown>;
  created_at: string;
};
export type MarkerRetrievalMode = "transcript" | "auto" | "vision";
export type MarkerProposalOperation = "create" | "update" | "delete" | "merge";
export type MarkerProposalChange = {
  operation: MarkerProposalOperation;
  before: MediaMarker[];
  after: MediaMarker | null;
  reason: string;
  evidence: string[];
};
export type MarkerProposal = {
  proposal_id: string;
  session_id: string;
  asset_id: string;
  changes: MarkerProposalChange[];
  status: "pending" | "accepted" | "rejected" | "stale";
  created_at: string;
};
export type MarkerAgentSession = {
  session: AgentSession;
  asset_id: string;
};
export type MarkerAgentSessionState = MarkerAgentSession & {
  events: AgentEvent[];
  proposals: MarkerProposal[];
};
export type SummaryAgentSession = {
  session: AgentSession;
  asset_id: string;
  root_document_id: string;
};
export type SummaryMediaSuggestion = {
  suggestion_id: string;
  media_type: "image" | "gif";
  start_seconds: number;
  end_seconds: number | null;
  insert_after: string | null;
  caption: string;
};
export type SummaryMediaArtifact = {
  media_id: string;
  asset_id: string;
  document_id: string;
  media_type: "image" | "gif";
  relative_path: string;
  caption: string;
  start_seconds: number;
  end_seconds: number | null;
  created_at: string;
};
export type SummaryEditProposal = {
  proposal_id: string;
  session_id: string;
  document_id: string;
  base_revision: number;
  proposed_markdown: string;
  explanation: string;
  diff: string;
  suggested_subdocuments: { title: string; markdown: string }[];
  media_suggestions: SummaryMediaSuggestion[];
  status: "pending" | "accepted" | "rejected" | "stale";
  created_at: string;
};
export type SummaryAgentSessionState = SummaryAgentSession & {
  events: AgentEvent[];
  proposals: SummaryEditProposal[];
};
export type AgentRun = {
  run_id: string;
  session_id: string;
  stage:
    "pending" | "running" | "complete" | "failed" | "cancelled" | "interrupted";
  error_message: string | null;
  created_at: string;
  updated_at: string;
};
