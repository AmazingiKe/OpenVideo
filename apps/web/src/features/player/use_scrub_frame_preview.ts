import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ScrubPreviewStoryboard,
  ScrubPreviewWorkerRequest,
  ScrubPreviewWorkerResponse,
} from "./scrub_preview_protocol";
import {
  contained_preview_rect,
  next_preview_quality_scale,
  preview_dimensions,
  storyboard_tile_at,
} from "./scrub_preview_calculations";

export type ScrubPreviewMetrics = {
  mode: "webcodecs" | "storyboard";
  requested_time_seconds: number;
  frame_time_seconds: number;
  frame_duration_seconds: number;
  decode_milliseconds: number;
  range_request_count: number;
  bytes_read: number;
  preview_width: number;
  preview_height: number;
};

type ScrubPreviewStatus = "idle" | "decoding" | "ready" | "unavailable";

export function use_scrub_frame_preview(
  source_url: string,
  fallback_storyboard: ScrubPreviewStoryboard | null,
  on_metrics?: (metrics: ScrubPreviewMetrics) => void,
) {
  const canvas_ref = useRef<HTMLCanvasElement>(null);
  const worker_ref = useRef<Worker | null>(null);
  const latest_request_id_ref = useRef(0);
  const requested_time_ref = useRef(0);
  const requested_dimensions_ref = useRef({ width: 1, height: 1 });
  const preview_quality_scale_ref = useRef(1);
  const fallback_image_ref = useRef<StoryboardImageCache | null>(null);
  const fallback_storyboard_ref = useRef(fallback_storyboard);
  const on_metrics_ref = useRef(on_metrics);
  const frame_callback_ref = useRef<
    | ((frame_time_seconds: number, frame_duration_seconds: number) => void)
    | null
  >(null);
  const [status, set_status] = useState<ScrubPreviewStatus>("idle");
  const [unavailable_reason, set_unavailable_reason] = useState<string | null>(
    null,
  );
  if (fallback_storyboard_ref.current?.url !== fallback_storyboard?.url) {
    fallback_image_ref.current = null;
  }
  fallback_storyboard_ref.current = fallback_storyboard;

  useEffect(() => {
    on_metrics_ref.current = on_metrics;
  }, [on_metrics]);

  useEffect(() => {
    if (!supports_worker_preview()) {
      set_status("unavailable");
      set_unavailable_reason("当前浏览器不支持 Worker 高清取帧");
      return;
    }
    const worker = new Worker(
      new URL("./scrub_preview.worker.ts", import.meta.url),
      {
        type: "module",
      },
    );
    worker_ref.current = worker;
    worker.onmessage = (event: MessageEvent<ScrubPreviewWorkerResponse>) => {
      const response = event.data;
      if (response.request_id !== latest_request_id_ref.current) {
        if (response.type === "frame") response.bitmap.close();
        return;
      }
      if (response.type === "unavailable") {
        set_unavailable_reason(response.reason);
        void draw_storyboard_fallback(
          canvas_ref.current,
          fallback_image_ref,
          fallback_storyboard_ref.current,
          requested_time_ref.current,
          requested_dimensions_ref.current,
          () => response.request_id === latest_request_id_ref.current,
        )
          .then((tile_time_seconds) => {
            if (response.request_id !== latest_request_id_ref.current) return;
            if (tile_time_seconds === null) {
              set_status("unavailable");
              return;
            }
            set_status("ready");
            on_metrics_ref.current?.({
              mode: "storyboard",
              requested_time_seconds: requested_time_ref.current,
              frame_time_seconds: tile_time_seconds,
              frame_duration_seconds: 0,
              decode_milliseconds: 0,
              range_request_count: 0,
              bytes_read: 0,
              preview_width: requested_dimensions_ref.current.width,
              preview_height: requested_dimensions_ref.current.height,
            });
          })
          .catch(() => {
            if (response.request_id === latest_request_id_ref.current) {
              set_status("unavailable");
            }
          });
        return;
      }
      const preview_width = response.bitmap.width;
      const preview_height = response.bitmap.height;
      draw_bitmap(canvas_ref.current, response.bitmap);
      preview_quality_scale_ref.current = next_preview_quality_scale(
        preview_quality_scale_ref.current,
        response.decode_milliseconds,
      );
      on_metrics_ref.current?.({
        mode: "webcodecs",
        requested_time_seconds: requested_time_ref.current,
        frame_time_seconds: response.frame_time_seconds,
        frame_duration_seconds: response.frame_duration_seconds,
        decode_milliseconds: response.decode_milliseconds,
        range_request_count: response.range_request_count,
        bytes_read: response.bytes_read,
        preview_width,
        preview_height,
      });
      frame_callback_ref.current?.(
        response.frame_time_seconds,
        response.frame_duration_seconds,
      );
      frame_callback_ref.current = null;
      set_status("ready");
      set_unavailable_reason(null);
    };
    worker.onerror = () => {
      set_status("unavailable");
      set_unavailable_reason("高清拖动预览 Worker 启动失败");
    };
    return () => {
      const request: ScrubPreviewWorkerRequest = { type: "dispose" };
      worker.postMessage(request);
      worker.terminate();
      worker_ref.current = null;
    };
  }, []);

  useEffect(() => {
    latest_request_id_ref.current += 1;
    worker_ref.current?.postMessage({
      type: "source-change",
      source_url,
    } satisfies ScrubPreviewWorkerRequest);
    set_status((current) => (current === "unavailable" ? current : "idle"));
    fallback_image_ref.current = null;
    preview_quality_scale_ref.current = 1;
  }, [source_url]);

  const request_frame = useCallback(
    (
      time_seconds: number,
      player_width: number,
      player_height: number,
      mode: "at" | "previous" | "next" = "at",
      on_frame?: (
        frame_time_seconds: number,
        frame_duration_seconds: number,
      ) => void,
    ) => {
      const worker = worker_ref.current;
      if (player_width <= 0 || player_height <= 0) return;
      const request_id = latest_request_id_ref.current + 1;
      latest_request_id_ref.current = request_id;
      requested_time_ref.current = time_seconds;
      frame_callback_ref.current = on_frame ?? null;
      const dimensions = preview_dimensions(
        player_width,
        player_height,
        window.devicePixelRatio || 1,
        preview_quality_scale_ref.current,
      );
      requested_dimensions_ref.current = dimensions;
      if (!worker) {
        set_status("decoding");
        void draw_storyboard_fallback(
          canvas_ref.current,
          fallback_image_ref,
          fallback_storyboard_ref.current,
          time_seconds,
          dimensions,
          () => request_id === latest_request_id_ref.current,
        )
          .then((tile_time_seconds) => {
            if (request_id !== latest_request_id_ref.current) return;
            if (tile_time_seconds === null) {
              set_status("unavailable");
              return;
            }
            set_status("ready");
            on_metrics_ref.current?.({
              mode: "storyboard",
              requested_time_seconds: time_seconds,
              frame_time_seconds: tile_time_seconds,
              frame_duration_seconds: 0,
              decode_milliseconds: 0,
              range_request_count: 0,
              bytes_read: 0,
              preview_width: dimensions.width,
              preview_height: dimensions.height,
            });
          })
          .catch(() => {
            if (request_id === latest_request_id_ref.current) {
              set_status("unavailable");
            }
          });
        return;
      }
      const request: ScrubPreviewWorkerRequest = {
        type: "decode",
        request_id,
        source_url,
        time_seconds,
        mode,
        ...dimensions,
      };
      set_status("decoding");
      worker.postMessage(request);
    },
    [source_url],
  );

  const clear = useCallback(() => {
    latest_request_id_ref.current += 1;
    frame_callback_ref.current = null;
    set_status((current) => (current === "unavailable" ? current : "idle"));
  }, []);

  return {
    canvas_ref,
    request_frame,
    clear,
    status,
    unavailable_reason,
  };
}

function supports_worker_preview() {
  return (
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof VideoDecoder !== "undefined"
  );
}

function draw_bitmap(canvas: HTMLCanvasElement | null, bitmap: ImageBitmap) {
  if (!canvas) {
    bitmap.close();
    return;
  }
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const bitmap_context = canvas.getContext("bitmaprenderer");
  if (bitmap_context) {
    bitmap_context.transferFromImageBitmap(bitmap);
    return;
  }
  const context = canvas.getContext("2d");
  context?.drawImage(bitmap, 0, 0);
  bitmap.close();
}

async function draw_storyboard_fallback(
  canvas: HTMLCanvasElement | null,
  image_ref: { current: StoryboardImageCache | null },
  storyboard: ScrubPreviewStoryboard | null,
  time_seconds: number,
  dimensions: { width: number; height: number },
  request_is_current: () => boolean,
) {
  if (!canvas || !storyboard) return null;
  const tile = storyboard_tile_at(storyboard, time_seconds);
  if (!tile) return null;
  const image = await load_storyboard_image(image_ref, storyboard.url);
  if (!request_is_current()) return null;
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const target = contained_preview_rect(
    storyboard.tile_width,
    storyboard.tile_height,
    dimensions.width,
    dimensions.height,
  );
  context.clearRect(0, 0, dimensions.width, dimensions.height);
  context.drawImage(
    image,
    tile.x,
    tile.y,
    storyboard.tile_width,
    storyboard.tile_height,
    target.x,
    target.y,
    target.width,
    target.height,
  );
  return tile.start_time;
}

function load_storyboard_image(
  image_ref: { current: StoryboardImageCache | null },
  url: string,
) {
  if (image_ref.current?.url === url) return image_ref.current.image;
  const image_promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("响应式缩略图加载失败"));
    image.src = url;
  });
  image_ref.current = { url, image: image_promise };
  return image_promise;
}

type StoryboardImageCache = {
  url: string;
  image: Promise<HTMLImageElement>;
};
