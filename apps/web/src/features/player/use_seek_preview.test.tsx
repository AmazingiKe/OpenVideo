import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { use_seek_preview } from "./use_seek_preview";

describe("use_seek_preview", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("marks a dragged time as active without committing a seek", () => {
    const { result } = renderHook(() =>
      use_seek_preview({ commit_timeout_milliseconds: 1_500 }),
    );

    act(() => expect(result.current.preview_to(-2)).toBe(0));
    expect(result.current.is_active()).toBe(true);

    act(() => expect(result.current.preview_to(8)).toBe(8));
    expect(result.current.is_active()).toBe(true);
  });

  it("keeps the drag active until the committed seek is confirmed", () => {
    const { result } = renderHook(() =>
      use_seek_preview({ commit_timeout_milliseconds: 1_500 }),
    );

    act(() => {
      result.current.preview_to(8);
      result.current.begin_seek_commit();
    });
    expect(result.current.is_active()).toBe(true);

    act(() => result.current.confirm_seek());
    expect(result.current.is_active()).toBe(false);
  });

  it("clears an unconfirmed preview after the commit timeout", () => {
    const { result } = renderHook(() =>
      use_seek_preview({ commit_timeout_milliseconds: 1_500 }),
    );

    act(() => {
      result.current.preview_to(8);
      result.current.begin_seek_commit();
      vi.advanceTimersByTime(1_500);
    });

    expect(result.current.is_active()).toBe(false);
  });
});
