import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  get_analysis_page_settings,
  update_analysis_page_settings,
} from "@/shared/api";
import {
  DEFAULT_ANALYSIS_PAGE_SETTINGS,
  use_analysis_page_settings,
} from "./use_analysis_page_settings";

vi.mock("@/shared/api", () => ({
  get_analysis_page_settings: vi.fn(),
  update_analysis_page_settings: vi.fn(),
}));

describe("use_analysis_page_settings", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.mocked(get_analysis_page_settings).mockResolvedValue(
      DEFAULT_ANALYSIS_PAGE_SETTINGS,
    );
    vi.mocked(update_analysis_page_settings).mockImplementation(async (value) =>
      Promise.resolve(value),
    );
  });

  it("loads settings and merges updates into one delayed save", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => use_analysis_page_settings());
    await act(async () => Promise.resolve());
    expect(result.current.is_ready).toBe(true);

    act(() => {
      result.current.update_settings({ asset_library_size_percent: 18 });
      result.current.update_settings({ tool_panel_size_percent: 24 });
    });
    await act(async () => vi.advanceTimersByTimeAsync(299));
    expect(update_analysis_page_settings).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(update_analysis_page_settings).toHaveBeenCalledOnce();
    expect(update_analysis_page_settings).toHaveBeenCalledWith(
      {
        ...DEFAULT_ANALYSIS_PAGE_SETTINGS,
        asset_library_size_percent: 18,
        tool_panel_size_percent: 24,
      },
      expect.any(AbortSignal),
    );
  });

  it("keeps defaults and reports a load failure", async () => {
    vi.mocked(get_analysis_page_settings).mockRejectedValue(
      new Error("设置读取失败"),
    );

    const { result } = renderHook(() => use_analysis_page_settings());

    await waitFor(() => expect(result.current.is_ready).toBe(true));
    expect(result.current.settings).toEqual(DEFAULT_ANALYSIS_PAGE_SETTINGS);
    expect(result.current.settings_error).toBe("设置读取失败");
  });

  it("reports a delayed save failure without reverting local settings", async () => {
    vi.useFakeTimers();
    vi.mocked(update_analysis_page_settings).mockRejectedValue(
      new Error("设置保存失败"),
    );
    const { result } = renderHook(() => use_analysis_page_settings());
    await act(async () => Promise.resolve());

    act(() =>
      result.current.update_settings({ asset_library_collapsed: true }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(300));

    expect(result.current.settings.asset_library_collapsed).toBe(true);
    expect(result.current.settings_error).toBe("设置保存失败");
  });
});
