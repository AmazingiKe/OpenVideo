import { describe, expect, it } from "vitest";

import type { MediaAsset } from "@/shared/types";

import { storyboard_for_asset } from "./use_storyboard_preview";

describe("storyboard_for_asset", () => {
  it("preserves the paginated server storyboard", () => {
    const storyboard = storyboard_for_asset({
      ...asset(),
      thumbnail_storyboard: {
        storyboard_id: "storyboard-asset",
        tile_width: 480,
        tile_height: 360,
        interval_seconds: 5,
        columns: 5,
        total_tiles: 25,
        pages: [
          {
            url: "/api/media/assets/asset/thumbnail-storyboard/pages/page",
            start_index: 0,
            tile_count: 25,
          },
        ],
      },
    });

    expect(storyboard).toEqual({
      storyboard_id: "storyboard-asset",
      tile_width: 480,
      tile_height: 360,
      interval_seconds: 5,
      columns: 5,
      total_tiles: 25,
      pages: [
        {
          url: "/api/media/assets/asset/thumbnail-storyboard/pages/page",
          start_index: 0,
          tile_count: 25,
        },
      ],
    });
  });

  it("does not invent a storyboard when the asset has none", () => {
    expect(storyboard_for_asset(asset())).toBeNull();
  });
});

function asset(): MediaAsset {
  return {
    asset_id: "asset",
    folder_id: null,
    media_type: "video",
    source_url: "https://example.com/video",
    source_platform: "youtube",
    source_video_id: null,
    title: "测试视频",
    author_name: null,
    description: null,
    duration_seconds: 20,
    width: 1440,
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
