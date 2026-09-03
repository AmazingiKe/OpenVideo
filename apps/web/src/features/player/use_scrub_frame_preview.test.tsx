import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScrubPreviewWorkerResponse } from "./scrub_preview_protocol";
import { use_scrub_frame_preview } from "./use_scrub_frame_preview";

const original_worker = globalThis.Worker;
const original_offscreen_canvas = globalThis.OffscreenCanvas;
const original_video_decoder = globalThis.VideoDecoder;
const original_request_animation_frame = window.requestAnimationFrame;
const original_cancel_animation_frame = window.cancelAnimationFrame;
const original_image = globalThis.Image;

class MockWorker {
  static latest: MockWorker;
  onmessage:
    ((event: MessageEvent<ScrubPreviewWorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  constructor() {
    MockWorker.latest = this;
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: MockWorker,
  });
  Object.defineProperty(globalThis, "OffscreenCanvas", {
    configurable: true,
    value: class {},
  });
  Object.defineProperty(globalThis, "VideoDecoder", {
    configurable: true,
    value: class {},
  });
  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    value: MockImage,
  });
  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: original_worker,
  });
  Object.defineProperty(globalThis, "OffscreenCanvas", {
    configurable: true,
    value: original_offscreen_canvas,
  });
  Object.defineProperty(globalThis, "VideoDecoder", {
    configurable: true,
    value: original_video_decoder,
  });
  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    value: original_image,
  });
  window.requestAnimationFrame = original_request_animation_frame;
  window.cancelAnimationFrame = original_cancel_animation_frame;
  vi.restoreAllMocks();
});

describe("use_scrub_frame_preview", () => {
  it("discards a completed frame once a newer target has been requested", async () => {
    const first_bitmap = bitmap();
    const second_bitmap = bitmap();
    const on_frame = vi.fn();
    const on_metrics = vi.fn();
    const { result, rerender, unmount } = renderHook(
      ({ source_url }) => use_scrub_frame_preview(source_url, null, on_metrics),
      { initialProps: { source_url: "/video.mp4" } },
    );

    act(() => {
      result.current.request_frame(4, 640, 360, "at", on_frame);
      result.current.request_frame(9, 640, 360, "at", on_frame);
    });
    const worker = MockWorker.latest;
    const decode_requests = worker.postMessage.mock.calls
      .map(([request]) => request)
      .filter((request) => request.type === "decode");
    const [first_request, second_request] = decode_requests;
    expect(first_request).toEqual(expect.objectContaining({ time_seconds: 4 }));
    expect(second_request).toEqual(
      expect.objectContaining({ time_seconds: 9 }),
    );

    act(() =>
      worker.onmessage?.(frame_response(first_request, first_bitmap, 4)),
    );
    expect(first_bitmap.close).toHaveBeenCalledOnce();
    expect(on_frame).not.toHaveBeenCalled();
    expect(on_metrics).not.toHaveBeenCalled();

    act(() =>
      worker.onmessage?.(frame_response(second_request, second_bitmap, 8.96)),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.has_preview_frame).toBe(true);
    expect(second_bitmap.close).toHaveBeenCalledOnce();
    expect(on_frame).toHaveBeenCalledWith(8.96, 0.04);

    act(() => result.current.request_frame(12, 640, 360));
    expect(result.current.has_preview_frame).toBe(true);

    rerender({ source_url: "/next-video.mp4" });
    expect(result.current.has_preview_frame).toBe(false);
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: "source-change",
      source_url: "/next-video.mp4",
    });

    unmount();
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "dispose" });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("renders a storyboard immediately and refines only after the pointer settles", async () => {
    let refinement_callback: (() => void) | null = null;
    vi.spyOn(window, "setTimeout").mockImplementation((handler) => {
      refinement_callback = handler as () => void;
      return 1 as unknown as ReturnType<typeof window.setTimeout>;
    });
    const { result } = renderHook(() =>
      use_scrub_frame_preview("/video.mp4", storyboard(), undefined),
    );
    const draw_image = vi.fn();
    const canvas = document.createElement("canvas");
    canvas.getContext = vi.fn(() => ({
      clearRect: vi.fn(),
      drawImage: draw_image,
    })) as unknown as typeof canvas.getContext;
    result.current.canvas_ref.current = canvas;

    await act(async () => {
      result.current.request_frame(4, 640, 360);
      await Promise.resolve();
    });

    const worker = MockWorker.latest;
    expect(result.current.status).toBe("ready");
    expect(draw_image).toHaveBeenCalledOnce();
    expect(
      worker.postMessage.mock.calls.filter(
        ([request]) => request.type === "decode",
      ),
    ).toHaveLength(0);

    act(() => refinement_callback?.());

    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "decode", time_seconds: 4 }),
    );
  });

  it("keeps worker previews responsive while the storyboard is still generating", () => {
    const { result } = renderHook(() =>
      use_scrub_frame_preview("/video.mp4", null, undefined),
    );

    act(() => result.current.request_frame(12, 640, 360));

    expect(MockWorker.latest.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "decode", time_seconds: 12 }),
    );
  });

  it("retries the latest request when an on-demand storyboard becomes available", async () => {
    const on_frame = vi.fn();
    const { result, rerender } = renderHook(
      ({ storyboard }) =>
        use_scrub_frame_preview("/video.mp4", storyboard, undefined),
      { initialProps: { storyboard: null as Storyboard | null } },
    );
    const canvas = document.createElement("canvas");
    canvas.getContext = vi.fn(() => ({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
    })) as unknown as typeof canvas.getContext;
    result.current.canvas_ref.current = canvas;

    act(() => result.current.request_frame(4, 640, 360, "at", on_frame));
    const worker = MockWorker.latest;
    const [request] = worker.postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "decode");
    act(() => worker.onmessage?.(unavailable_response(request)));
    await waitFor(() => expect(result.current.status).toBe("unavailable"));

    rerender({ storyboard: storyboard() });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(on_frame).toHaveBeenCalledWith(0, 5);
  });
});

class MockImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  set src(_url: string) {
    queueMicrotask(() => this.onload?.());
  }
}

type Storyboard = {
  storyboard_id: string;
  tile_width: number;
  tile_height: number;
  interval_seconds: number;
  columns: number;
  total_tiles: number;
  pages: { url: string; start_index: number; tile_count: number }[];
};

function storyboard(): Storyboard {
  return {
    storyboard_id: "storyboard-asset",
    tile_width: 640,
    tile_height: 360,
    interval_seconds: 5,
    columns: 5,
    total_tiles: 1,
    pages: [
      {
        url: "/api/media/assets/asset/thumbnail-storyboard/pages/page",
        start_index: 0,
        tile_count: 1,
      },
    ],
  };
}

function bitmap() {
  return {
    width: 1280,
    height: 720,
    close: vi.fn(),
  } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

function frame_response(
  request: { session_id: number; request_id: number; time_seconds: number },
  frame_bitmap: ImageBitmap,
  frame_time_seconds: number,
): MessageEvent<ScrubPreviewWorkerResponse> {
  return new MessageEvent("message", {
    data: {
      type: "frame",
      session_id: request.session_id,
      request_id: request.request_id,
      requested_time_seconds: request.time_seconds,
      frame_time_seconds,
      frame_duration_seconds: 0.04,
      decode_milliseconds: 12,
      range_request_count: 2,
      bytes_read: 4096,
      bitmap: frame_bitmap,
    },
  });
}

function unavailable_response(request: {
  session_id: number;
  request_id: number;
  time_seconds: number;
}): MessageEvent<ScrubPreviewWorkerResponse> {
  return new MessageEvent("message", {
    data: {
      type: "unavailable",
      session_id: request.session_id,
      request_id: request.request_id,
      requested_time_seconds: request.time_seconds,
      width: 640,
      height: 360,
      reason: "当前视频编码无法通过 WebCodecs 解码",
    },
  });
}
