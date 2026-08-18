import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { use_asset_markers } from "./use_asset_markers";


const ASSET_ID = "asset-test";

beforeEach(() => {
  localStorage.clear();
});

describe("use_asset_markers", () => {
  it("adds and persists markers per asset", () => {
    const { result } = renderHook(() => use_asset_markers(ASSET_ID));
    expect(result.current.markers).toEqual([]);

    act(() => result.current.add_marker(12.9));
    act(() => result.current.add_marker(30.2));
    expect(result.current.markers.map((marker) => marker.time_seconds)).toEqual([12, 30]);

    const reloaded = renderHook(() => use_asset_markers(ASSET_ID));
    expect(reloaded.result.current.markers).toHaveLength(2);
  });

  it("adds and removes tags from a marker", () => {
    const { result } = renderHook(() => use_asset_markers(ASSET_ID));
    act(() => result.current.add_marker(12));
    const marker_id = result.current.markers[0].id;

    act(() => result.current.add_tag(marker_id, "重点画面"));
    act(() => result.current.add_tag(marker_id, "重点画面"));
    expect(result.current.markers[0].tags).toEqual(["重点画面"]);

    act(() => result.current.remove_tag(marker_id, "重点画面"));
    expect(result.current.markers[0].tags).toEqual([]);
  });

  it("ignores markers within one second and removes by id", () => {
    const { result } = renderHook(() => use_asset_markers(ASSET_ID));
    act(() => result.current.add_marker(100));
    act(() => result.current.add_marker(100.4));
    expect(result.current.markers).toHaveLength(1);

    const marker_id = result.current.markers[0].id;
    act(() => result.current.remove_marker(marker_id));
    expect(result.current.markers).toEqual([]);
  });

  it("isolates markers between different assets", () => {
    const first = renderHook(() => use_asset_markers("asset-a"));
    act(() => first.result.current.add_marker(5));

    const second = renderHook(() => use_asset_markers("asset-b"));
    expect(second.result.current.markers).toEqual([]);
    expect(renderHook(() => use_asset_markers("asset-a")).result.current.markers).toHaveLength(1);
  });

  it("discards malformed stored values", () => {
    localStorage.setItem("openvideo.player.markers.asset-bad", '{"not":"array"}');
    const { result } = renderHook(() => use_asset_markers("asset-bad"));
    expect(result.current.markers).toEqual([]);

    localStorage.setItem(
      "openvideo.player.markers.asset-bad",
      JSON.stringify([{ id: "x", time_seconds: -3 }]),
    );
    const reloaded = renderHook(() => use_asset_markers("asset-bad"));
    expect(reloaded.result.current.markers).toEqual([]);
  });
});
