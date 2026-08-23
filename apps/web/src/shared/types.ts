type DependencyStatus = {
  yt_dlp: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
};

type SourcePlatform = "bilibili" | "douyin" | "youtube";

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
};

export type Preferences = {
  tools_directory: string | null;
  models_directory: string | null;
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
  input_modalities: AiInputModality[];
};

export type AiModelConfiguration = AiModelSummary & {
  api_key: string | null;
  api_base: string | null;
  api_version: string | null;
};

export type AnalysisToolSection =
  "video_information" | "transcription" | "transcript_correction" | "analysis";

export type TranscriptCorrectionScope = "all" | "selection";

export type AnalysisPageSettings = {
  asset_library_size_percent: number;
  asset_library_collapsed: boolean;
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
export type AnalysisOperation = "transcription" | "analysis";
export type TranscriptionOptions = {
  model: string;
  language: string | null;
  compute_type: string;
};
type AnalysisCapability = "transcript" | "timeline" | "visual";

export type AnalysisJob = {
  job_id: string;
  asset_id: string;
  operation: AnalysisOperation;
  mode: AnalysisMode;
  marker_ids: string[];
  ai_model_id: string | null;
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
  time_seconds: number;
  tags: string[];
};

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
