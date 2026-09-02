import { describe, expect, it } from "vitest";

import type { MediaAsset } from "@/shared/types";

import { storyboard_for_asset } from "./use_storyboard_fallback";

describe("storyboard_for_asset", () => {
  it("preserves the server-provided tile dimensions and source ratio", () => {
    const storyboard = storyboard_for_asset({
      ...asset(),
      thumbnail_storyboard: {
        version: 2,
        url: "/api/media/assets/asset/thumbnail-sprite",
        tile_width: 480,
        tile_height: 360,
        tiles: [{ start_time: 0, x: 0, y: 0 }],
      },
    });

    expect(storyboard).toEqual({
      url: "/api/media/assets/asset/thumbnail-sprite",
      tile_width: 480,
      tile_height: 360,
      tiles: [{ start_time: 0, x: 0, y: 0 }],
    });
  });

  it("does not invent a fallback when the asset has no storyboard", () => {
    expect(storyboard_for_asset(asset())).toBeNull();
  });

  it("rejects legacy storyboards so they are regenerated on demand", () => {
    expect(
      storyboard_for_asset({
        ...asset(),
        thumbnail_storyboard: {
          version: 1,
          url: "/api/media/assets/asset/thumbnail-sprite",
          tile_width: 640,
          tile_height: 360,
          tiles: [{ start_time: 0, x: 0, y: 0 }],
        },
      }),
    ).toBeNull();
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
