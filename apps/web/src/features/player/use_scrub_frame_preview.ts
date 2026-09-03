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

const HIGH_DEFINITION_REFINEMENT_DELAY_MILLISECONDS = 140;
const MAXIMUM_CACHED_STORYBOARD_PAGES = 3;

type ScrubPreviewStatus = "idle" | "decoding" | "ready" | "unavailable";

type PendingFrameRequest = Omit<ScrubPreviewRequest, "source_url" | "type">;

type FrameCallback = {
  session_id: number;
  request_id: number;
  callback: (
    frame_time_seconds: number,
    frame_duration_seconds: number,
  ) => void;
};

export function use_scrub_frame_preview(
  source_url: string,
  storyboard: ScrubPreviewStoryboard | null,
  on_metrics?: (metrics: ScrubPreviewMetrics) => void,
) {
  const canvas_ref = useRef<HTMLCanvasElement>(null);
  const worker_ref = useRef<Worker | null>(null);
  const active_session_id_ref = useRef(0);
  const next_request_id_ref = useRef(0);
  const latest_request_id_ref = useRef(0);
  const latest_request_ref = useRef<PendingFrameRequest | null>(null);
  const queued_request_ref = useRef<PendingFrameRequest | null>(null);
  const animation_frame_ref = useRef<number | null>(null);
  const refinement_timeout_ref = useRef<number | null>(null);
  const session_dimensions_ref = useRef<{
    width: number;
    height: number;
  } | null>(null);
  const preview_quality_scale_ref = useRef(1);
  const storyboard_image_cache_ref = useRef<StoryboardImageCache>(new Map());
  const storyboard_ref = useRef(storyboard);
  const on_metrics_ref = useRef(on_metrics);
  const frame_callback_ref = useRef<FrameCallback | null>(null);
  const [has_preview_frame, set_has_preview_frame] = useState(false);
  const [status, set_status] = useState<ScrubPreviewStatus>("idle");
  const [unavailable_reason, set_unavailable_reason] = useState<string | null>(
    null,
  );
  if (storyboard_ref.current?.storyboard_id !== storyboard?.storyboard_id) {
    storyboard_image_cache_ref.current.clear();
  }
  storyboard_ref.current = storyboard;

  const cancel_queued_request = useCallback(() => {
    if (animation_frame_ref.current !== null) {
      window.cancelAnimationFrame(animation_frame_ref.current);
      animation_frame_ref.current = null;
    }
    if (refinement_timeout_ref.current !== null) {
      window.clearTimeout(refinement_timeout_ref.current);
      refinement_timeout_ref.current = null;
    }
    queued_request_ref.current = null;
  }, []);

  const invalidate_preview_session = useCallback(() => {
    active_session_id_ref.current += 1;
    latest_request_id_ref.current = 0;
    latest_request_ref.current = null;
    frame_callback_ref.current = null;
    session_dimensions_ref.current = null;
    cancel_queued_request();
  }, [cancel_queued_request]);

  const can_display_request = useCallback(
    (session_id: number, request_id: number) =>
      session_id === active_session_id_ref.current &&
      request_id === latest_request_id_ref.current,
    [],
  );

  const record_displayed_request = useCallback(() => {
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

  const render_storyboard = useCallback(
    (request: PendingFrameRequest) => {
      void draw_storyboard(
        canvas_ref.current,
        storyboard_image_cache_ref.current,
        storyboard_ref.current,
        request.time_seconds,
        { width: request.width, height: request.height },
        () => can_display_request(request.session_id, request.request_id),
      )
        .then((tile) => {
          if (!can_display_request(request.session_id, request.request_id)) {
            return;
          }
          if (tile === null) {
            set_status("unavailable");
            return;
          }
          record_displayed_request();
          on_metrics_ref.current?.({
            mode: "storyboard",
            requested_time_seconds: request.time_seconds,
            frame_time_seconds: tile.start_time,
            frame_duration_seconds: tile.duration,
            decode_milliseconds: 0,
            range_request_count: 0,
            bytes_read: 0,
            preview_width: request.width,
            preview_height: request.height,
          });
          resolve_frame_callback(
            request.session_id,
            request.request_id,
            tile.start_time,
            tile.duration,
          );
        })
        .catch(() => {
          if (can_display_request(request.session_id, request.request_id)) {
            set_status("unavailable");
          }
        });
    },
    [can_display_request, record_displayed_request, resolve_frame_callback],
  );

  const dispatch_worker_request = useCallback(
    (request: PendingFrameRequest) => {
      const worker = worker_ref.current;
      set_status("decoding");
      if (!worker) {
        render_storyboard(request);
        return;
      }
      worker.postMessage({
        type: "decode",
        source_url,
        ...request,
      } satisfies ScrubPreviewWorkerRequest);
    },
    [render_storyboard, source_url],
  );

  const schedule_high_definition_refinement = useCallback(
    (request: PendingFrameRequest, immediate: boolean) => {
      if (refinement_timeout_ref.current !== null) {
        window.clearTimeout(refinement_timeout_ref.current);
      }
      if (immediate) {
        refinement_timeout_ref.current = null;
        dispatch_worker_request(request);
        return;
      }
      refinement_timeout_ref.current = window.setTimeout(() => {
        refinement_timeout_ref.current = null;
        if (can_display_request(request.session_id, request.request_id)) {
          dispatch_worker_request(request);
        }
      }, HIGH_DEFINITION_REFINEMENT_DELAY_MILLISECONDS);
    },
    [can_display_request, dispatch_worker_request],
  );

  const present_request = useCallback(
    (request: PendingFrameRequest, immediate: boolean) => {
      if (request.mode === "at" && storyboard_ref.current) {
        render_storyboard(request);
        schedule_high_definition_refinement(request, immediate);
        return;
      }
      schedule_high_definition_refinement(request, true);
    },
    [render_storyboard, schedule_high_definition_refinement],
  );

  const schedule_request = useCallback(
    (request: PendingFrameRequest, immediate: boolean) => {
      if (immediate) {
        present_request(request, true);
        return;
      }
      queued_request_ref.current = request;
      if (animation_frame_ref.current !== null) return;
      animation_frame_ref.current = window.requestAnimationFrame(() => {
        animation_frame_ref.current = null;
        const queued_request = queued_request_ref.current;
        queued_request_ref.current = null;
        if (queued_request) present_request(queued_request, false);
      });
    },
    [present_request],
  );

  useEffect(() => {
    on_metrics_ref.current = on_metrics;
  }, [on_metrics]);

  useEffect(() => {
    if (status !== "unavailable" || !storyboard) return;
    const latest_request = latest_request_ref.current;
    if (latest_request) render_storyboard(latest_request);
  }, [render_storyboard, status, storyboard]);

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
        set_status("unavailable");
        set_unavailable_reason(response.reason);
        render_storyboard({
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
      record_displayed_request();
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
      if (worker_ref.current === worker) {
        worker.terminate();
        worker_ref.current = null;
      }
      set_status("unavailable");
      set_unavailable_reason("高清拖动预览 Worker 启动失败");
      const latest_request = latest_request_ref.current;
      if (latest_request) render_storyboard(latest_request);
    };
    return () => {
      invalidate_preview_session();
      if (worker_ref.current === worker) {
        const request: ScrubPreviewWorkerRequest = { type: "dispose" };
        worker.postMessage(request);
        worker.terminate();
        worker_ref.current = null;
      }
    };
  }, [
    can_display_request,
    invalidate_preview_session,
    record_displayed_request,
    render_storyboard,
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
    storyboard_image_cache_ref.current.clear();
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
      const dimensions =
        session_dimensions_ref.current ??
        preview_dimensions(
          player_width,
          player_height,
          window.devicePixelRatio || 1,
          preview_quality_scale_ref.current,
        );
      session_dimensions_ref.current = dimensions;
      const request: PendingFrameRequest = {
        session_id: active_session_id_ref.current,
        request_id,
        time_seconds,
        mode,
        ...dimensions,
      };
      latest_request_id_ref.current = request_id;
      latest_request_ref.current = request;
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

async function draw_storyboard(
  canvas: HTMLCanvasElement | null,
  image_cache: StoryboardImageCache,
  storyboard: ScrubPreviewStoryboard | null,
  time_seconds: number,
  dimensions: { width: number; height: number },
  can_draw: () => boolean,
) {
  if (!canvas || !storyboard) return null;
  const tile = storyboard_tile_at(storyboard, time_seconds);
  if (!tile) return null;
  const image = await load_storyboard_image(image_cache, tile.url);
  if (!can_draw()) return null;
  preload_adjacent_storyboard_pages(image_cache, storyboard, tile.url);
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
  return tile;
}

function resize_canvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
) {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

function load_storyboard_image(image_cache: StoryboardImageCache, url: string) {
  const cached_image = image_cache.get(url);
  if (cached_image) {
    image_cache.delete(url);
    image_cache.set(url, cached_image);
    return cached_image;
  }
  const image_promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("分页预览图加载失败"));
    image.src = url;
  });
  image_cache.set(url, image_promise);
  while (image_cache.size > MAXIMUM_CACHED_STORYBOARD_PAGES) {
    const oldest_url = image_cache.keys().next().value;
    if (typeof oldest_url !== "string") break;
    image_cache.delete(oldest_url);
  }
  void image_promise.catch(() => {
    if (image_cache.get(url) === image_promise) image_cache.delete(url);
  });
  return image_promise;
}

function preload_adjacent_storyboard_pages(
  image_cache: StoryboardImageCache,
  storyboard: ScrubPreviewStoryboard,
  current_url: string,
) {
  const current_index = storyboard.pages.findIndex(
    (page) => page.url === current_url,
  );
  if (current_index < 0) return;
  for (const page_index of [current_index - 1, current_index + 1]) {
    const page = storyboard.pages[page_index];
    if (page)
      void load_storyboard_image(image_cache, page.url).catch(() => undefined);
  }
}

type StoryboardImageCache = Map<string, Promise<HTMLImageElement>>;
