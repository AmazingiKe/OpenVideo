import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { use_scrub_preview } from "./use_scrub_preview";

describe("use_scrub_preview", () => {
  let next_frame: FrameRequestCallback | null;
  let request_animation_frame: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    next_frame = null;
    request_animation_frame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        next_frame = callback;
        return 1;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function run_frame() {
    const callback = next_frame;
    next_frame = null;
    if (!callback) throw new Error("没有待执行的预览帧");
    callback(0);
  }

  it("falls back to the main player when no proxy video is available", () => {
    const { result } = renderHook(() =>
      use_scrub_preview({
        src: null,
        commit_timeout_milliseconds: 1_500,
      }),
    );

    act(() => {
      expect(result.current.preview_to(-2)).toBe(0);
      run_frame();
    });

    expect(result.current.fallback_seek_request).toEqual({ seconds: 0 });
    expect(result.current.preview_time).toBe(0);
    expect(result.current.is_active()).toBe(true);
    expect(result.current.is_visible).toBe(false);
  });

  it("keeps a new preview hidden until its requested frame is ready", () => {
    const { result } = renderHook(() =>
      use_scrub_preview({
        src: "/scrub.mp4",
        commit_timeout_milliseconds: 1_500,
      }),
    );
    const video = document.createElement("video");
    Object.defineProperties(video, {
      readyState: { value: HTMLMediaElement.HAVE_METADATA },
      duration: { value: 20 },
    });
    result.current.video_ref.current = video;

    act(() => {
      result.current.preview_to(8);
      run_frame();
    });
    expect(video.currentTime).toBe(8);
    expect(result.current.preview_time).toBe(8);
    expect(result.current.is_visible).toBe(false);

    act(() => result.current.on_seeked());
    expect(result.current.is_visible).toBe(true);

    act(() => {
      result.current.begin_seek_commit();
      result.current.confirm_seek();
    });
    expect(result.current.is_visible).toBe(false);
    expect(result.current.is_active()).toBe(false);
    expect(result.current.preview_time).toBeNull();

    act(() => result.current.preview_to(9));
    expect(result.current.is_visible).toBe(false);
  });

  it("falls back to the main player while proxy metadata is loading", () => {
    const { result } = renderHook(() =>
      use_scrub_preview({
        src: "/scrub.mp4",
        commit_timeout_milliseconds: 1_500,
      }),
    );
    const video = document.createElement("video");
    result.current.video_ref.current = video;

    act(() => {
      result.current.preview_to(8);
      run_frame();
    });

    expect(result.current.fallback_seek_request).toEqual({ seconds: 8 });
    expect(video.currentTime).toBe(0);
    expect(result.current.preview_time).toBe(8);
    expect(result.current.is_visible).toBe(false);
  });

  it("waits for the current proxy seek before applying the latest request", () => {
    const { result } = renderHook(() =>
      use_scrub_preview({
        src: "/scrub.mp4",
        commit_timeout_milliseconds: 1_500,
      }),
    );
    let is_seeking = true;
    const video = document.createElement("video");
    Object.defineProperties(video, {
      readyState: { value: HTMLMediaElement.HAVE_METADATA },
      duration: { value: 20 },
      seeking: { get: () => is_seeking },
    });
    result.current.video_ref.current = video;

    act(() => {
      result.current.preview_to(8);
      run_frame();
    });
    expect(video.currentTime).toBe(0);
    expect(result.current.preview_time).toBe(8);

    is_seeking = false;
    act(() => {
      result.current.on_seeked();
      run_frame();
    });
    expect(video.currentTime).toBe(8);
  });

  it("cancels queued work when the preview unmounts", () => {
    const { result, unmount } = renderHook(() =>
      use_scrub_preview({
        src: "/scrub.mp4",
        commit_timeout_milliseconds: 1_500,
      }),
    );

    act(() => result.current.preview_to(6));
    unmount();

    expect(request_animation_frame).toHaveBeenCalledOnce();
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(1);
  });
});
