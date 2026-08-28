import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  get_markers_page_settings,
  update_markers_page_settings,
} from "@/shared/api";
import {
  DEFAULT_MARKERS_PAGE_SETTINGS,
  use_markers_page_settings,
} from "./use_markers_page_settings";
import { ApplicationQueryProvider } from "@/app/query_cache";

vi.mock("@/shared/api", () => ({
  get_markers_page_settings: vi.fn(),
  update_markers_page_settings: vi.fn(),
}));

describe("use_markers_page_settings", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.mocked(get_markers_page_settings).mockResolvedValue(
      DEFAULT_MARKERS_PAGE_SETTINGS,
    );
    vi.mocked(update_markers_page_settings).mockImplementation(async (value) =>
      Promise.resolve(value),
    );
  });

  it("loads settings and merges updates into one delayed save", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => use_markers_page_settings(), {
      wrapper: ApplicationQueryProvider,
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.is_ready).toBe(true);

    act(() => {
      result.current.update_settings({ left_panel_size_percent: 28 });
      result.current.update_settings({ left_panel_tab: "agent" });
    });
    await act(async () => vi.advanceTimersByTimeAsync(299));
    expect(update_markers_page_settings).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(update_markers_page_settings).toHaveBeenCalledOnce();
    expect(update_markers_page_settings).toHaveBeenCalledWith(
      {
        ...DEFAULT_MARKERS_PAGE_SETTINGS,
        left_panel_size_percent: 28,
        left_panel_tab: "agent",
      },
      expect.any(AbortSignal),
    );
  });

  it("keeps defaults and reports a load failure", async () => {
    vi.mocked(get_markers_page_settings).mockRejectedValue(
      new Error("设置读取失败"),
    );

    const { result } = renderHook(() => use_markers_page_settings(), {
      wrapper: ApplicationQueryProvider,
    });

    await waitFor(() => expect(result.current.is_ready).toBe(true));
    expect(result.current.settings).toEqual(DEFAULT_MARKERS_PAGE_SETTINGS);
    expect(result.current.settings_error).toBe("设置读取失败");
  });

  it("reports a delayed save failure without reverting local settings", async () => {
    vi.useFakeTimers();
    vi.mocked(update_markers_page_settings).mockRejectedValue(
      new Error("设置保存失败"),
    );
    const { result } = renderHook(() => use_markers_page_settings(), {
      wrapper: ApplicationQueryProvider,
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));

    act(() => result.current.update_settings({ left_panel_collapsed: true }));
    await act(async () => vi.advanceTimersByTimeAsync(300));

    expect(result.current.settings.left_panel_collapsed).toBe(true);
    expect(result.current.settings_error).toBe("设置保存失败");
  });
});
