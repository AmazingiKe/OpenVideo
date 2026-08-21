export type DependencyStatus = {
  yt_dlp: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
};

export type SourcePlatform = "bilibili" | "douyin" | "youtube";

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

export type DownloadStage =
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

export type AnalysisStage =
  | "pending"
  | "extracting_audio"
  | "transcribing"
  | "building_timeline"
  | "extracting_frames"
  | "describing_visuals"
  | "complete"
  | "failed";

export type AnalysisMode = "full" | "markers";
export type AnalysisCapability = "transcript" | "timeline" | "visual";

export type AnalysisJob = {
  job_id: string;
  asset_id: string;
  mode: AnalysisMode;
  marker_ids: string[];
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

export type ThumbnailStoryboard = {
  url: string;
  tile_width: number;
  tile_height: number;
  tiles: { start_time: number; x: number; y: number }[];
};

export type MediaAsset = {
  asset_id: string;
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
