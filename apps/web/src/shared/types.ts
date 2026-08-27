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

export type DownloadFolderSelection = string | null | undefined;

export type DownloadQuality =
  "best" | "2160p" | "1440p" | "1080p" | "720p" | "480p";

export type DownloadDestination = {
  video_quality: DownloadQuality;
  folder_id: string | null;
  automatic_folder_name: string | null;
  assign_folder: boolean;
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

const MODEL_CAPABILITY_NAMES = [
  "tools",
  "reasoning",
  "vision",
  "structured_output",
  "streaming_tools",
  "reasoning_tools",
  "tool_choice_auto",
  "tool_choice_required",
  "tool_choice_named",
  "parallel_tools",
  "vision_tools",
] as const;

export type ModelCapabilityName = (typeof MODEL_CAPABILITY_NAMES)[number];
export type ModelCapabilitySupport = "yes" | "no" | "unknown";
export type ModelCapabilityOverride = "auto" | "enabled" | "disabled";
export type ModelCapabilitySource =
  | "user_override"
  | "runtime_probe"
  | "local_override"
  | "models_dev"
  | "litellm_metadata"
  | "unknown";

export type ModelCapabilityOverrides = Record<
  ModelCapabilityName,
  ModelCapabilityOverride
>;

export const DEFAULT_MODEL_CAPABILITY_OVERRIDES: ModelCapabilityOverrides =
  Object.fromEntries(
    MODEL_CAPABILITY_NAMES.map((capability) => [capability, "auto"]),
  ) as ModelCapabilityOverrides;

export type ModelProfile = {
  provider: string;
  model: string;
  capabilities: Record<ModelCapabilityName, ModelCapabilitySupport>;
  quirks: {
    disable_named_tool_choice_when_reasoning: boolean;
    omit_tool_choice_when_reasoning: boolean;
    preserve_reasoning_content: boolean;
    require_assistant_content: boolean;
  };
  limits: {
    context_tokens: number | null;
    max_output_tokens: number | null;
  };
  capability_sources: Partial<
    Record<ModelCapabilityName, ModelCapabilitySource>
  >;
};

export function unknown_model_profile(
  provider: string,
  model: string,
): ModelProfile {
  const capabilities = Object.fromEntries(
    MODEL_CAPABILITY_NAMES.map((capability) => [capability, "unknown"]),
  ) as Record<ModelCapabilityName, ModelCapabilitySupport>;
  return {
    provider,
    model,
    capabilities,
    quirks: {
      disable_named_tool_choice_when_reasoning: false,
      omit_tool_choice_when_reasoning: false,
      preserve_reasoning_content: false,
      require_assistant_content: false,
    },
    limits: { context_tokens: null, max_output_tokens: null },
    capability_sources: {},
  };
}

export type AiModelConfiguration = {
  model_id: string;
  name: string;
  litellm_model: string;
  input_modalities: AiInputModality[];
  capabilities: ModelCapabilityOverrides;
  api_key: string | null;
  api_base: string | null;
  api_version: string | null;
};

export type AiModelSummary = Pick<
  AiModelConfiguration,
  "model_id" | "name" | "litellm_model" | "input_modalities" | "capabilities"
> & { profile: ModelProfile };

export type AiModelTestResult = {
  available: boolean;
  latency_ms: number;
  message: string;
  capabilities: Partial<
    Record<
      "text" | ModelCapabilityName,
      {
        support: ModelCapabilitySupport;
        source: ModelCapabilitySource;
        tested: boolean;
        message: string;
      }
    >
  >;
  profile: ModelProfile;
};

export type AnalysisToolSection =
  "video_information" | "transcription" | "transcript_correction" | "analysis";

export type MarkersPageSettings = {
  agent_panel_size_percent: number;
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

export type DownloadEvent = {
  event_id: string;
  job_id: string;
  stage: DownloadStage;
  progress_percent: number;
  message: string;
  error_message: string | null;
  created_at: string;
};

export type DownloadJob = {
  job_id: string;
  asset_id: string;
  video_quality: DownloadQuality;
  stage: DownloadStage;
  progress_percent: number;
  message: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  name: string;
  events: DownloadEvent[];
};

type AnalysisStage =
  | "pending"
  | "extracting_audio"
  | "transcribing"
  | "building_timeline"
  | "extracting_frames"
  | "describing_visuals"
  | "waiting_for_approval"
  | "complete"
  | "rejected"
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
  proposal_base_digest: string | null;
  proposed_segments: MediaSegment[];
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
  importance: MarkerImportance;
};

export type MarkerImportance = 0 | 1 | 2 | 3 | 4 | 5;

export type MediaMarkerCreate = Pick<
  MediaMarker,
  "start_seconds" | "end_seconds"
> & { importance?: MarkerImportance };

export type MediaMarkerUpdate = Partial<
  Pick<MediaMarker, "start_seconds" | "end_seconds" | "importance">
>;

type ThumbnailStoryboard = {
  url: string;
  tile_width: number;
  tile_height: number;
  tiles: { start_time: number; x: number; y: number }[];
};

export type MediaAsset = {
  asset_id: string;
  folder_id: string | null;
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
  scrub_preview_url: string | null;
  thumbnail_url: string | null;
  thumbnail_storyboard: ThumbnailStoryboard | null;
  created_at: string;
  updated_at: string;
};

export type LibraryFolder = {
  folder_id: string;
  name: string;
  parent_id: string | null;
  materialized_path: string;
  direct_asset_count: number;
  recursive_asset_count: number;
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
  agent_id: string;
  asset_id: string;
  title: string;
  context: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};
export type AgentEventType =
  | "run.status"
  | "message.delta"
  | "reasoning.delta"
  | "message.completed"
  | "tool.status"
  | "artifact.created"
  | "context.compressed"
  | "run.completed"
  | "run.failed"
  | "run.cancelled";
export type AgentEvent = {
  event_id: string;
  session_id: string;
  sequence: number;
  run_id: string | null;
  event_type: AgentEventType;
  payload: Record<string, unknown>;
  created_at: string;
};
export type AgentRun = {
  run_id: string;
  session_id: string;
  request_key: string;
  model_id: string;
  stage:
    | "pending"
    | "running"
    | "waiting_for_approval"
    | "complete"
    | "failed"
    | "cancelled"
    | "interrupted";
  error_code: string | null;
  error_message: string | null;
  latest_event_sequence: number;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
};

export type AgentCapability = "tools" | "vision" | "long_context";
export type AgentToolDescriptor = {
  name: string;
  description: string;
  prerequisites: string[];
};
export type AgentDefinition = {
  agent_id: string;
  title: string;
  description: string;
  mode: "chat" | "task";
  prompt: string;
  required_capabilities: AgentCapability[];
  minimum_context_tokens: number;
  tools: AgentToolDescriptor[];
  required_tools: string[];
  requires_approval: boolean;
  result_type: string | null;
  input_mode: "message" | "task";
};
export type AgentDefinitionAvailability = {
  definition: AgentDefinition;
  available: boolean;
  compatible_model_ids: string[];
  capability_model_ids: Partial<Record<AgentCapability, string[]>>;
  unavailable_reason: string | null;
};
export type AgentArtifact = {
  artifact_id: string;
  run_id: string;
  session_id: string;
  agent_id: string;
  asset_id: string;
  result_type: string;
  payload: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "stale";
  error_message: string | null;
  created_at: string;
  updated_at: string;
};
export type AgentSessionState = {
  session: AgentSession;
  runs: AgentRun[];
  events: AgentEvent[];
  artifacts: AgentArtifact[];
};
