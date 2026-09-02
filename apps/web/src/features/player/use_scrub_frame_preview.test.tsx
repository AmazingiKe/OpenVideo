import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScrubPreviewWorkerResponse } from "./scrub_preview_protocol";
import { use_scrub_frame_preview } from "./use_scrub_frame_preview";

const original_worker = globalThis.Worker;
const original_offscreen_canvas = globalThis.OffscreenCanvas;
const original_video_decoder = globalThis.VideoDecoder;

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
});

afterEach(() => {
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
  vi.restoreAllMocks();
});

describe("use_scrub_frame_preview", () => {
  it("keeps only the newest response and releases stale bitmaps", async () => {
    const first_bitmap = bitmap();
    const second_bitmap = bitmap();
    const on_frame = vi.fn();
    const { result, rerender, unmount } = renderHook(
      ({ source_url }) => use_scrub_frame_preview(source_url, null),
      { initialProps: { source_url: "/video.mp4" } },
    );

    act(() => {
      result.current.request_frame(4, 640, 360);
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
      worker.onmessage?.(
        frame_response(first_request.request_id, first_bitmap, 4),
      ),
    );
    expect(first_bitmap.close).toHaveBeenCalledOnce();
    expect(on_frame).not.toHaveBeenCalled();

    act(() =>
      worker.onmessage?.(
        frame_response(second_request.request_id, second_bitmap, 8.96),
      ),
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
});

function bitmap() {
  return {
    width: 1280,
    height: 720,
    close: vi.fn(),
  } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

function frame_response(
  request_id: number,
  frame_bitmap: ImageBitmap,
  frame_time_seconds: number,
): MessageEvent<ScrubPreviewWorkerResponse> {
  return new MessageEvent("message", {
    data: {
      type: "frame",
      request_id,
      frame_time_seconds,
      frame_duration_seconds: 0.04,
      decode_milliseconds: 12,
      range_request_count: 2,
      bytes_read: 4096,
      bitmap: frame_bitmap,
    },
  });
}
