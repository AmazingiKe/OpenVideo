import { createRef, forwardRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VideoWorkspace } from "./VideoWorkspace";
import type { PlayerHandle } from "../player/Player";
import type { MediaAsset } from "../../shared/types";


vi.mock("../player/Player", () => ({
  Player: forwardRef(function Player() {
    return <div data-testid="player" />;
  }),
}));

const ASSET_ID = "asset-0123456789abcdef0123456789abcdef";

describe("VideoWorkspace", () => {
  it("lets the user analyze only selected markers", () => {
    const start_analysis = vi.fn();
    render(
      <VideoWorkspace
        asset={create_asset()}
        markers={[
          {
            marker_id: "marker-0123456789abcdef0123456789abcdef",
            asset_id: ASSET_ID,
            time_seconds: 30,
            tags: ["公式"],
          },
          {
            marker_id: "marker-1123456789abcdef0123456789abcdef",
            asset_id: ASSET_ID,
            time_seconds: 90,
            tags: ["疑问"],
          },
        ]}
        current_time={0}
        player_ref={createRef<PlayerHandle>()}
        on_time_change={vi.fn()}
        on_add_marker={vi.fn()}
        is_analyzing={false}
        on_start_analysis={start_analysis}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "标记重点分析" }));
    const marker_options = screen.getAllByRole("checkbox");
    expect(marker_options).toHaveLength(2);
    expect(screen.getByRole("button", { name: "分析 2 个标记" })).toBeEnabled();

    fireEvent.click(marker_options[0]);
    fireEvent.click(screen.getByRole("button", { name: "分析 1 个标记" }));

    expect(start_analysis).toHaveBeenCalledWith(
      "markers",
      ["marker-1123456789abcdef0123456789abcdef"],
    );
  });
});

function create_asset(): MediaAsset {
  return {
    asset_id: ASSET_ID,
    source_url: "https://www.bilibili.com/video/BV1xx411c7mD",
    source_platform: "bilibili",
    source_video_id: "BV1xx411c7mD",
    title: "课程视频",
    author_name: "讲师",
    description: null,
    duration_seconds: 180,
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
