import { createRef, forwardRef } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayerHandle } from "@/features/player/Player";
import type { MediaAsset } from "@/shared/types";
import { VideoWorkspace } from "./VideoWorkspace";

const player_render = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ setQueryData: vi.fn() }),
}));

vi.mock("@/shared/api", () => ({
  create_subtitle_export: vi.fn(),
  media_url: (path: string) => path,
  update_subtitle_settings: vi.fn(),
}));

vi.mock("@/features/player/Player", () => ({
  Player: forwardRef(function Player(props) {
    player_render(props);
    return <div data-testid="marker-player" />;
  }),
}));

describe("VideoWorkspace", () => {
  beforeEach(() => player_render.mockClear());

  it("keeps the marker player inside its workspace and forwards timeline state", () => {
    const on_time_change = vi.fn();
    const on_pause_change = vi.fn();
    const on_playback_rate_change = vi.fn();

    render(
      <VideoWorkspace
        asset={create_asset()}
        markers={[]}
        transcript={null}
        player_ref={createRef<PlayerHandle>()}
        on_time_change={on_time_change}
        on_pause_change={on_pause_change}
        on_playback_rate_change={on_playback_rate_change}
      />,
    );

    const workspace = screen.getByRole("region", { name: "视频工作区" });
    expect(workspace).toContainElement(screen.getByTestId("marker-player"));
    expect(player_render.mock.lastCall?.[0]).toMatchObject({
      src: "/stream",
      on_time_change,
      on_pause_change,
      on_playback_rate_change,
    });
  });

  it("keeps the player mounted across unrelated parent renders", () => {
    const props = {
      asset: create_asset(),
      markers: [],
      transcript: null,
      player_ref: createRef<PlayerHandle>(),
      on_time_change: vi.fn(),
      on_pause_change: vi.fn(),
      on_playback_rate_change: vi.fn(),
    };
    const workspace = render(<VideoWorkspace {...props} />);

    workspace.rerender(<VideoWorkspace {...props} />);

    expect(player_render).toHaveBeenCalledOnce();
  });
});

function create_asset(): MediaAsset {
  return {
    asset_id: "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f",
    folder_id: null,
    media_type: "video",
    source_url: "https://www.bilibili.com/video/BV1xx411c7mD",
    source_platform: "bilibili",
    source_video_id: "BV1xx411c7mD",
    title: "标记视频",
    author_name: "作者",
    description: null,
    duration_seconds: 60,
    width: 1920,
    height: 1080,
    video_codec: "h264",
    audio_codec: "aac",
    status: "ready",
    error_message: null,
    playback_url: "/stream",
    thumbnail_url: null,
    thumbnail_storyboard: null,
    subtitle_display: {
      font_size: "medium",
      position: "bottom",
      background: "shadow",
      offset_milliseconds: 0,
    },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}
