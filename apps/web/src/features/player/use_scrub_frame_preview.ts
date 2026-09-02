import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ScrubPreviewRequest,
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

type PendingFrameRequest = Omit<
  ScrubPreviewRequest,
  "source_url" | "type"
>;

type FrameCallback = {
  session_id: number;
  request_id: number;
  callback: (frame_time_seconds: number, frame_duration_seconds: number) => void;
};

export function use_scrub_frame_preview(
  source_url: string,
  fallback_storyboard: ScrubPreviewStoryboard | null,
  on_metrics?: (metrics: ScrubPreviewMetrics) => void,
) {
  const canvas_ref = useRef<HTMLCanvasElement>(null);
  const worker_ref = useRef<Worker | null>(null);
  const active_session_id_ref = useRef(0);
  const next_request_id_ref = useRef(0);
  const latest_drawn_request_id_ref = useRef(0);
  const queued_request_ref = useRef<PendingFrameRequest | null>(null);
  const animation_frame_ref = useRef<number | null>(null);
  const preview_quality_scale_ref = useRef(1);
  const fallback_image_ref = useRef<StoryboardImageCache | null>(null);
  const fallback_storyboard_ref = useRef(fallback_storyboard);
  const on_metrics_ref = useRef(on_metrics);
  const frame_callback_ref = useRef<FrameCallback | null>(null);
  const [has_preview_frame, set_has_preview_frame] = useState(false);
  const [status, set_status] = useState<ScrubPreviewStatus>("idle");
  const [unavailable_reason, set_unavailable_reason] = useState<string | null>(
    null,
  );
  if (fallback_storyboard_ref.current?.url !== fallback_storyboard?.url) {
    fallback_image_ref.current = null;
  }
  fallback_storyboard_ref.current = fallback_storyboard;

  const cancel_queued_request = useCallback(() => {
    if (animation_frame_ref.current !== null) {
      window.cancelAnimationFrame(animation_frame_ref.current);
      animation_frame_ref.current = null;
    }
    queued_request_ref.current = null;
  }, []);

  const invalidate_preview_session = useCallback(() => {
    active_session_id_ref.current += 1;
    latest_drawn_request_id_ref.current = 0;
    frame_callback_ref.current = null;
    cancel_queued_request();
  }, [cancel_queued_request]);

  const can_display_request = useCallback(
    (session_id: number, request_id: number) =>
      session_id === active_session_id_ref.current &&
      request_id >= latest_drawn_request_id_ref.current,
    [],
  );

  const record_displayed_request = useCallback((request_id: number) => {
    latest_drawn_request_id_ref.current = request_id;
    set_has_preview_frame(true);
    set_status("ready");
  }, []);

  const resolve_frame_callback = useCallback(
    (
      session_id: number,
      request_id: number,
      frame_time_seconds: number,
      frame_duration_seconds: number,
    ) => {
      const pending_callback = frame_callback_ref.current;
      if (
        !pending_callback ||
        pending_callback.session_id !== session_id ||
        pending_callback.request_id !== request_id
      ) {
        return;
      }
      frame_callback_ref.current = null;
      pending_callback.callback(frame_time_seconds, frame_duration_seconds);
    },
    [],
  );

  const render_storyboard_fallback = useCallback(
    (request: PendingFrameRequest) => {
      void draw_storyboard_fallback(
        canvas_ref.current,
        fallback_image_ref,
        fallback_storyboard_ref.current,
        request.time_seconds,
        { width: request.width, height: request.height },
        () => can_display_request(request.session_id, request.request_id),
      )
        .then((tile_time_seconds) => {
          if (
            tile_time_seconds === null ||
            !can_display_request(request.session_id, request.request_id)
          ) {
            return;
          }
          record_displayed_request(request.request_id);
          on_metrics_ref.current?.({
            mode: "storyboard",
            requested_time_seconds: request.time_seconds,
            frame_time_seconds: tile_time_seconds,
            frame_duration_seconds: 0,
            decode_milliseconds: 0,
            range_request_count: 0,
            bytes_read: 0,
            preview_width: request.width,
            preview_height: request.height,
          });
          resolve_frame_callback(
            request.session_id,
            request.request_id,
            tile_time_seconds,
            0,
          );
        })
        .catch(() => {
          if (request.session_id === active_session_id_ref.current) {
            set_status("unavailable");
          }
        });
    },
    [can_display_request, record_displayed_request, resolve_frame_callback],
  );

  const dispatch_request = useCallback(
    (request: PendingFrameRequest) => {
      const worker = worker_ref.current;
      set_status("decoding");
      if (!worker) {
        render_storyboard_fallback(request);
        return;
      }
      worker.postMessage({
        type: "decode",
        source_url,
        ...request,
      } satisfies ScrubPreviewWorkerRequest);
    },
    [render_storyboard_fallback, source_url],
  );

  const schedule_request = useCallback(
    (request: PendingFrameRequest, immediate: boolean) => {
      if (immediate) {
        dispatch_request(request);
        return;
      }
      queued_request_ref.current = request;
      if (animation_frame_ref.current !== null) return;
      animation_frame_ref.current = window.requestAnimationFrame(() => {
        animation_frame_ref.current = null;
        const queued_request = queued_request_ref.current;
        queued_request_ref.current = null;
        if (queued_request) dispatch_request(queued_request);
      });
    },
    [dispatch_request],
  );

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
      if (response.session_id !== active_session_id_ref.current) {
        if (response.type === "frame") response.bitmap.close();
        return;
      }
      if (response.type === "unavailable") {
        set_unavailable_reason(response.reason);
        render_storyboard_fallback({
          session_id: response.session_id,
          request_id: response.request_id,
          time_seconds: response.requested_time_seconds,
          width: response.width,
          height: response.height,
          mode: "at",
        });
        return;
      }
      if (!can_display_request(response.session_id, response.request_id)) {
        response.bitmap.close();
        return;
      }
      const preview_width = response.bitmap.width;
      const preview_height = response.bitmap.height;
      draw_bitmap(canvas_ref.current, response.bitmap);
      preview_quality_scale_ref.current = next_preview_quality_scale(
        preview_quality_scale_ref.current,
        response.decode_milliseconds,
      );
      record_displayed_request(response.request_id);
      on_metrics_ref.current?.({
        mode: "webcodecs",
        requested_time_seconds: response.requested_time_seconds,
        frame_time_seconds: response.frame_time_seconds,
        frame_duration_seconds: response.frame_duration_seconds,
        decode_milliseconds: response.decode_milliseconds,
        range_request_count: response.range_request_count,
        bytes_read: response.bytes_read,
        preview_width,
        preview_height,
      });
      resolve_frame_callback(
        response.session_id,
        response.request_id,
        response.frame_time_seconds,
        response.frame_duration_seconds,
      );
      set_unavailable_reason(null);
    };
    worker.onerror = () => {
      set_status("unavailable");
      set_unavailable_reason("高清拖动预览 Worker 启动失败");
    };
    return () => {
      invalidate_preview_session();
      const request: ScrubPreviewWorkerRequest = { type: "dispose" };
      worker.postMessage(request);
      worker.terminate();
      worker_ref.current = null;
    };
  }, [
    can_display_request,
    invalidate_preview_session,
    record_displayed_request,
    render_storyboard_fallback,
    resolve_frame_callback,
  ]);

  useEffect(() => {
    invalidate_preview_session();
    worker_ref.current?.postMessage({
      type: "source-change",
      source_url,
    } satisfies ScrubPreviewWorkerRequest);
    set_status((current) => (current === "unavailable" ? current : "idle"));
    set_has_preview_frame(false);
    fallback_image_ref.current = null;
    preview_quality_scale_ref.current = 1;
  }, [invalidate_preview_session, source_url]);

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
      if (player_width <= 0 || player_height <= 0) return;
      const request_id = next_request_id_ref.current + 1;
      next_request_id_ref.current = request_id;
      const dimensions = preview_dimensions(
        player_width,
        player_height,
        window.devicePixelRatio || 1,
        preview_quality_scale_ref.current,
      );
      const request: PendingFrameRequest = {
        session_id: active_session_id_ref.current,
        request_id,
        time_seconds,
        mode,
        ...dimensions,
      };
      if (on_frame) {
        frame_callback_ref.current = {
          session_id: request.session_id,
          request_id,
          callback: on_frame,
        };
      }
      schedule_request(request, mode !== "at" || on_frame !== undefined);
    },
    [schedule_request],
  );

  const end_preview = useCallback(() => {
    invalidate_preview_session();
  }, [invalidate_preview_session]);

  const clear = useCallback(() => {
    invalidate_preview_session();
    set_status((current) => (current === "unavailable" ? current : "idle"));
    set_has_preview_frame(false);
  }, [invalidate_preview_session]);

  return {
    canvas_ref,
    request_frame,
    end_preview,
    clear,
    has_preview_frame,
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
  resize_canvas(canvas, bitmap.width, bitmap.height);
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
  can_draw: () => boolean,
) {
  if (!canvas || !storyboard) return null;
  const tile = storyboard_tile_at(storyboard, time_seconds);
  if (!tile) return null;
  const image = await load_storyboard_image(image_ref, storyboard.url);
  if (!can_draw()) return null;
  resize_canvas(canvas, dimensions.width, dimensions.height);
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

function resize_canvas(canvas: HTMLCanvasElement, width: number, height: number) {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
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
