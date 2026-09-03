/// <reference lib="webworker" />

import { ALL_FORMATS, CanvasSink, Input, UrlSource } from "mediabunny";

import type {
  ScrubPreviewRequest,
  ScrubPreviewWorkerRequest,
  ScrubPreviewWorkerResponse,
} from "./scrub_preview_protocol";

const SOURCE_CACHE_BYTES = 32 * 1024 * 1024;
const SOURCE_PARALLELISM = 2;

let active_input: Input<UrlSource> | null = null;
let active_sink: CanvasSink | null = null;
let active_sink_width = 0;
let active_sink_height = 0;
let active_source_url: string | null = null;
let pending_request: ScrubPreviewRequest | null = null;
let processing = false;
let active_network_metrics: NetworkMetrics | null = null;

self.onmessage = (event: MessageEvent<ScrubPreviewWorkerRequest>) => {
  if (event.data.type === "dispose") {
    pending_request = null;
    dispose_input();
    return;
  }
  if (event.data.type === "source-change") {
    pending_request = null;
    if (active_source_url !== event.data.source_url) dispose_input();
    return;
  }
  if (active_source_url && active_source_url !== event.data.source_url) {
    dispose_input();
  }
  pending_request = event.data;
  if (!processing) void process_latest_request();
};

async function process_latest_request() {
  processing = true;
  while (pending_request) {
    const request = pending_request;
    pending_request = null;
    await decode_frame(request);
  }
  processing = false;
}

async function decode_frame(request: ScrubPreviewRequest) {
  const started_at = performance.now();
  try {
    if (
      typeof VideoDecoder === "undefined" ||
      typeof OffscreenCanvas === "undefined" ||
      typeof createImageBitmap === "undefined"
    ) {
      post_unavailable(request, "当前环境不支持 WebCodecs Worker 取帧");
      return;
    }
    release_sink_for_new_dimensions(request.width, request.height);
    const input = input_for(request.source_url);
    const network_metrics = active_network_metrics;
    const range_request_count_at_start = network_metrics?.request_count ?? 0;
    const bytes_read_at_start = network_metrics?.bytes_read ?? 0;
    const sink = await sink_for(input, request.width, request.height);
    if (!sink) {
      post_unavailable(request, "当前视频编码无法通过 WebCodecs 解码");
      return;
    }
    const current_frame = await sink.getCanvas(request.time_seconds);
    const result = await stepped_frame(sink, current_frame, request.mode);
    if (!result) {
      post_unavailable(request, "目标时间没有可用视频帧");
      return;
    }
    if (has_newer_pending_request(request)) return;
    const bitmap = await createImageBitmap(result.canvas);
    const response: ScrubPreviewWorkerResponse = {
      type: "frame",
      session_id: request.session_id,
      request_id: request.request_id,
      requested_time_seconds: request.time_seconds,
      frame_time_seconds: result.timestamp,
      frame_duration_seconds: result.duration,
      decode_milliseconds: performance.now() - started_at,
      range_request_count:
        (network_metrics?.request_count ?? 0) - range_request_count_at_start,
      bytes_read: (network_metrics?.bytes_read ?? 0) - bytes_read_at_start,
      bitmap,
    };
    self.postMessage(response, { transfer: [bitmap] });
  } catch (error) {
    if (active_input?.disposed) return;
    post_unavailable(
      request,
      error instanceof Error ? error.message : "拖动预览解码失败",
    );
  }
}

async function stepped_frame(
  sink: CanvasSink,
  current_frame: Awaited<ReturnType<CanvasSink["getCanvas"]>>,
  mode: ScrubPreviewRequest["mode"],
) {
  if (!current_frame || mode === "at") return current_frame;
  if (mode === "previous") {
    return sink.getCanvas(Math.max(0, current_frame.timestamp - 0.000_001));
  }
  return sink.getCanvas(
    current_frame.timestamp + current_frame.duration + 0.000_001,
  );
}

function input_for(source_url: string): Input<UrlSource> {
  if (active_input && active_source_url === source_url) return active_input;
  dispose_input();
  const network_metrics: NetworkMetrics = { request_count: 0, bytes_read: 0 };
  const source = new UrlSource(source_url, {
    maxCacheSize: SOURCE_CACHE_BYTES,
    parallelism: SOURCE_PARALLELISM,
    fetchFn: async (input, init) => {
      const response = await fetch(input, init);
      network_metrics.request_count += 1;
      if (!response.body) return response;
      const counting_stream = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          network_metrics.bytes_read += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      return new Response(response.body.pipeThrough(counting_stream), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  });
  active_source_url = source_url;
  active_network_metrics = network_metrics;
  active_input = new Input({ source, formats: ALL_FORMATS });
  return active_input;
}

async function sink_for(
  input: Input<UrlSource>,
  width: number,
  height: number,
) {
  if (
    active_sink &&
    active_sink_width === width &&
    active_sink_height === height
  ) {
    return active_sink;
  }
  const video_track = await input.getPrimaryVideoTrack();
  if (!video_track || !(await video_track.canDecode())) return null;
  active_sink_width = width;
  active_sink_height = height;
  active_sink = new CanvasSink(video_track, {
    width,
    height,
    fit: "contain",
    poolSize: 1,
    decoderOptions: { hardwareAcceleration: "prefer-hardware" },
  });
  return active_sink;
}

function dispose_input() {
  active_input?.dispose();
  active_input = null;
  active_sink = null;
  active_sink_width = 0;
  active_sink_height = 0;
  active_source_url = null;
  active_network_metrics = null;
}

function release_sink_for_new_dimensions(width: number, height: number) {
  if (
    !active_sink ||
    (active_sink_width === width && active_sink_height === height)
  ) {
    return;
  }
  active_sink = null;
  active_sink_width = 0;
  active_sink_height = 0;
}

function has_newer_pending_request(request: ScrubPreviewRequest) {
  return (
    pending_request?.session_id === request.session_id &&
    pending_request.request_id > request.request_id
  );
}

function post_unavailable(request: ScrubPreviewRequest, reason: string) {
  const response: ScrubPreviewWorkerResponse = {
    type: "unavailable",
    session_id: request.session_id,
    request_id: request.request_id,
    requested_time_seconds: request.time_seconds,
    width: request.width,
    height: request.height,
    reason,
  };
  self.postMessage(response);
}

type NetworkMetrics = {
  request_count: number;
  bytes_read: number;
};
