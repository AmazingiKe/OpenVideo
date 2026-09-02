import { describe, expect, it } from "vitest";

import type { LibraryFolder, MediaAsset } from "@/shared/types";
import {
  create_library_browser_items,
  create_library_browser_rows,
  library_browser_column_count,
  library_item_row_index,
} from "./library_browser_rows";

const FOLDER = {
  folder_id: "folder-019c0000000070008000000000000001",
  name: "课程",
  parent_id: null,
  materialized_path: "/folder-019c0000000070008000000000000001/",
  direct_asset_count: 0,
  recursive_asset_count: 2,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} satisfies LibraryFolder;

const ASSETS = [video(1), video(2), video(3)];

describe("library browser rows", () => {
  it("calculates responsive grid columns using the thumbnail minimum", () => {
    expect(library_browser_column_count(180, 208)).toBe(1);
    expect(library_browser_column_count(640, 208)).toBe(2);
    expect(library_browser_column_count(880, 208)).toBe(4);
  });

  it("keeps folders before videos and groups grid rows", () => {
    const items = create_library_browser_items([FOLDER], ASSETS);
    const rows = create_library_browser_rows(items, "grid", 2);

    expect(rows).toHaveLength(2);
    expect(rows[0].items.map((item) => item.kind)).toEqual(["folder", "video"]);
    expect(rows[1].items.map((item) => item.id)).toEqual([
      ASSETS[1].asset_id,
      ASSETS[2].asset_id,
    ]);
  });

  it("uses one semantic item per list row and locates its row", () => {
    const rows = create_library_browser_rows(
      create_library_browser_items([FOLDER], ASSETS),
      "list",
      4,
    );

    expect(rows).toHaveLength(4);
    expect(library_item_row_index(rows, ASSETS[1].asset_id)).toBe(2);
    expect(library_item_row_index(rows, "missing")).toBe(-1);
  });
});

function video(index: number): MediaAsset {
  const suffix = index.toString(16).padStart(12, "0");
  return {
    asset_id: `019c0000-0000-7000-8000-${suffix}`,
    folder_id: null,
    media_type: "video",
    source_url: "https://example.com/video",
    source_platform: "bilibili",
    source_video_id: `BV${index}`,
    title: `视频 ${index}`,
    author_name: "开放影像课",
    description: null,
    duration_seconds: 120,
    width: 1920,
    height: 1080,
    video_codec: "h264",
    audio_codec: "aac",
    status: "ready",
    error_message: null,
    playback_url: "/stream",
    thumbnail_url: null,
    thumbnail_storyboard: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}
