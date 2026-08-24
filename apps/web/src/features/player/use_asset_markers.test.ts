import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApplicationQueryProvider } from "@/app/query_cache";
import {
  create_marker,
  delete_marker,
  get_markers,
  update_marker,
} from "@/shared/api";
import { use_asset_markers } from "./use_asset_markers";

const ASSET_ID = "asset-test";

vi.mock("@/shared/api", () => ({
  create_marker: vi.fn(),
  delete_marker: vi.fn(),
  get_markers: vi.fn(),
  update_marker: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(get_markers).mockResolvedValue([]);
});

describe("use_asset_markers", () => {
  it("loads and creates markers through the media API", async () => {
    vi.mocked(get_markers).mockResolvedValueOnce([
      {
        marker_id: "marker-existing",
        asset_id: ASSET_ID,
        time_seconds: 8,
        tags: [],
      },
    ]);
    vi.mocked(create_marker).mockResolvedValueOnce({
      marker_id: "marker-new",
      asset_id: ASSET_ID,
      time_seconds: 12.9,
      tags: [],
    });
    const { result } = renderHook(() => use_asset_markers(ASSET_ID), {
      wrapper: ApplicationQueryProvider,
    });
    await waitFor(() => expect(result.current.markers).toHaveLength(1));

    await act(async () => result.current.add_marker(12.9));

    expect(create_marker).toHaveBeenCalledWith(ASSET_ID, 12.9, []);
    expect(result.current.markers.map((marker) => marker.time_seconds)).toEqual(
      [8, 12.9],
    );
  });

  it("updates tags and deletes markers through the media API", async () => {
    vi.mocked(get_markers).mockResolvedValueOnce([
      {
        marker_id: "marker-a",
        asset_id: ASSET_ID,
        time_seconds: 12,
        tags: ["重点"],
      },
    ]);
    vi.mocked(update_marker).mockResolvedValueOnce({
      marker_id: "marker-a",
      asset_id: ASSET_ID,
      time_seconds: 12,
      tags: ["关键帧"],
    });
    const { result } = renderHook(() => use_asset_markers(ASSET_ID), {
      wrapper: ApplicationQueryProvider,
    });
    await waitFor(() => expect(result.current.markers).toHaveLength(1));

    await act(async () =>
      result.current.update_marker_tags("marker-a", ["关键帧"]),
    );
    expect(update_marker).toHaveBeenCalledWith(ASSET_ID, "marker-a", [
      "关键帧",
    ]);
    expect(result.current.markers[0].tags).toEqual(["关键帧"]);

    await act(async () => result.current.remove_marker("marker-a"));
    expect(delete_marker).toHaveBeenCalledWith(ASSET_ID, "marker-a");
    expect(result.current.markers).toEqual([]);
  });

  it("reloads markers when the asset changes", () => {
    vi.mocked(get_markers)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          marker_id: "marker-b",
          asset_id: "asset-b",
          time_seconds: 8,
          tags: [],
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
        result.current.markers.map((marker) => marker.time_seconds),
      ).toEqual([8]),
    );
  });
});
