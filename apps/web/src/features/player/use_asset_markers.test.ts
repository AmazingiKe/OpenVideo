import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApplicationQueryProvider } from "@/app/query_cache";
import {
  create_marker,
  delete_marker,
  get_markers,
  update_marker,
} from "@/shared/api";
import type { MediaMarker } from "@/shared/types";
import { use_asset_markers } from "./use_asset_markers";

const ASSET_ID = "asset-test";
const EXISTING_MARKER = {
  marker_id: "marker-existing",
  asset_id: ASSET_ID,
  start_seconds: 8,
  end_seconds: null,
  importance: 0 as const,
};

vi.mock("@/shared/api", () => ({
  create_marker: vi.fn(),
  delete_marker: vi.fn(),
  get_markers: vi.fn(),
  update_marker: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(get_markers).mockResolvedValue([]);
});

describe("use_asset_markers", () => {
  it("loads and creates markers through the media API", async () => {
    vi.mocked(get_markers).mockResolvedValueOnce([EXISTING_MARKER]);
    vi.mocked(create_marker).mockResolvedValueOnce({
      marker_id: "marker-new",
      asset_id: ASSET_ID,
      start_seconds: 12.9,
      end_seconds: null,
      importance: 0,
    });
    const { result } = renderHook(() => use_asset_markers(ASSET_ID), {
      wrapper: ApplicationQueryProvider,
    });
    await waitFor(() => expect(result.current.markers).toHaveLength(1));

    await act(async () => result.current.add_marker(12.9));

    expect(create_marker).toHaveBeenCalledWith(ASSET_ID, {
      start_seconds: 12.9,
      end_seconds: null,
    });
    expect(
      result.current.markers.map((marker) => marker.start_seconds),
    ).toEqual([8, 12.9]);
  });

  it("partially updates and deletes markers through the media API", async () => {
    const marker = { ...EXISTING_MARKER, marker_id: "marker-a" };
    vi.mocked(get_markers).mockResolvedValueOnce([marker]);
    vi.mocked(update_marker).mockResolvedValueOnce({
      ...marker,
      end_seconds: 27,
      importance: 4,
    });
    const { result } = renderHook(() => use_asset_markers(ASSET_ID), {
      wrapper: ApplicationQueryProvider,
    });
    await waitFor(() => expect(result.current.markers).toHaveLength(1));

    await act(async () =>
      result.current.update_marker("marker-a", {
        end_seconds: 27,
        importance: 4,
      }),
    );
    expect(update_marker).toHaveBeenCalledWith(ASSET_ID, "marker-a", {
      end_seconds: 27,
      importance: 4,
    });
    expect(result.current.markers[0].importance).toBe(4);

    await act(async () => result.current.remove_marker("marker-a"));
    expect(delete_marker).toHaveBeenCalledWith(ASSET_ID, "marker-a");
    expect(result.current.markers).toEqual([]);
  });

  it("reloads markers when the asset changes", () => {
    vi.mocked(get_markers)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          ...EXISTING_MARKER,
          marker_id: "marker-b",
          asset_id: "asset-b",
        },
      ]);
    const { result, rerender } = renderHook(
      ({ asset_id }) => use_asset_markers(asset_id),
      {
        initialProps: { asset_id: "asset-a" },
        wrapper: ApplicationQueryProvider,
      },
    );

    rerender({ asset_id: "asset-b" });

    return waitFor(() =>
      expect(
        result.current.markers.map((marker) => marker.start_seconds),
      ).toEqual([8]),
    );
  });

  it("serializes rapid ratings and only applies the latest response", async () => {
    let resolve_first!: (marker: MediaMarker) => void;
    let resolve_second!: (marker: MediaMarker) => void;
    vi.mocked(get_markers).mockResolvedValueOnce([EXISTING_MARKER]);
    vi.mocked(update_marker)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolve_first = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolve_second = resolve;
          }),
      );
    const { result } = renderHook(() => use_asset_markers(ASSET_ID), {
      wrapper: ApplicationQueryProvider,
    });
    await waitFor(() => expect(result.current.markers).toHaveLength(1));

    let first_request!: Promise<void>;
    let second_request!: Promise<void>;
    act(() => {
      first_request = result.current.update_marker("marker-existing", {
        importance: 1,
      });
      second_request = result.current.update_marker("marker-existing", {
        importance: 5,
      });
    });
    await waitFor(() => expect(result.current.markers[0].importance).toBe(5));
    await waitFor(() => expect(update_marker).toHaveBeenCalledOnce());

    resolve_first({ ...EXISTING_MARKER, importance: 1 });
    await waitFor(() => expect(update_marker).toHaveBeenCalledTimes(2));
    expect(result.current.markers[0].importance).toBe(5);
    resolve_second({ ...EXISTING_MARKER, importance: 5 });
    await act(async () => Promise.all([first_request, second_request]));
    expect(result.current.markers[0].importance).toBe(5);
  });

  it("rolls back a failed optimistic rating to the last confirmed value", async () => {
    const confirmed_marker = { ...EXISTING_MARKER, importance: 3 as const };
    vi.mocked(get_markers).mockResolvedValueOnce([confirmed_marker]);
    vi.mocked(update_marker).mockRejectedValueOnce(new Error("保存失败"));
    const { result } = renderHook(() => use_asset_markers(ASSET_ID), {
      wrapper: ApplicationQueryProvider,
    });
    await waitFor(() => expect(result.current.markers).toHaveLength(1));

    await act(async () => {
      await expect(
        result.current.update_marker("marker-existing", { importance: 5 }),
      ).rejects.toThrow("保存失败");
    });

    expect(result.current.markers[0].importance).toBe(3);
    expect(result.current.marker_error).toBe("保存失败");
  });
});
