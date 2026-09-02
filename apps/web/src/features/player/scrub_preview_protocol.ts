export type ScrubPreviewRequest = {
  type: "decode";
  request_id: number;
  source_url: string;
  time_seconds: number;
  width: number;
  height: number;
  mode: "at" | "previous" | "next";
};

export type ScrubPreviewStoryboard = {
  url: string;
  tile_width: number;
  tile_height: number;
  tiles: { start_time: number; x: number; y: number }[];
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
  request_id: number;
  frame_time_seconds: number;
  frame_duration_seconds: number;
  decode_milliseconds: number;
  range_request_count: number;
  bytes_read: number;
  bitmap: ImageBitmap;
};

type ScrubPreviewUnavailableResponse = {
  type: "unavailable";
  request_id: number;
  reason: string;
};

export type ScrubPreviewWorkerResponse =
  ScrubPreviewFrameResponse | ScrubPreviewUnavailableResponse;
