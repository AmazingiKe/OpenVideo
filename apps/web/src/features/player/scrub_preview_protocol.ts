export type ScrubPreviewRequest = {
  type: "decode";
  session_id: number;
  request_id: number;
  source_url: string;
  time_seconds: number;
  width: number;
  height: number;
  mode: "at" | "previous" | "next";
};

export type ScrubPreviewStoryboard = {
  storyboard_id: string;
  tile_width: number;
  tile_height: number;
  interval_seconds: number;
  columns: number;
  total_tiles: number;
  pages: { url: string; start_index: number; tile_count: number }[];
};

type ScrubPreviewDisposeRequest = {
  type: "dispose";
};

type ScrubPreviewSourceChangeRequest = {
  type: "source-change";
  source_url: string;
};

export type ScrubPreviewWorkerRequest =
  | ScrubPreviewRequest
  | ScrubPreviewSourceChangeRequest
  | ScrubPreviewDisposeRequest;

type ScrubPreviewFrameResponse = {
  type: "frame";
  session_id: number;
  request_id: number;
  requested_time_seconds: number;
  frame_time_seconds: number;
  frame_duration_seconds: number;
  decode_milliseconds: number;
  range_request_count: number;
  bytes_read: number;
  bitmap: ImageBitmap;
};

type ScrubPreviewUnavailableResponse = {
  type: "unavailable";
  session_id: number;
  request_id: number;
  requested_time_seconds: number;
  width: number;
  height: number;
  reason: string;
};

export type ScrubPreviewWorkerResponse =
  ScrubPreviewFrameResponse | ScrubPreviewUnavailableResponse;
