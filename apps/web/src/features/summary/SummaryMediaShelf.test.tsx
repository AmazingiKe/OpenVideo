import { act, forwardRef, useImperativeHandle } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayerHandle } from "@/features/player/Player";
import type { MediaAsset } from "@/shared/types";
import { SummaryMediaShelf } from "./SummaryMediaShelf";

const player_render = vi.hoisted(() => vi.fn());
const player_pause = vi.hoisted(() => vi.fn());
const player_toggle = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ setQueryData: vi.fn() }),
}));

vi.mock("@/shared/api", () => ({
  ensure_thumbnail_storyboard: vi.fn(),
  media_url: (path: string) => path,
}));

vi.mock("@/features/player/Player", () => ({
  Player: forwardRef<PlayerHandle, Record<string, unknown>>(function Player(
    props,
    ref,
  ) {
    player_render(props);
    useImperativeHandle(ref, () => ({
      current_time: () => 0,
      pause: player_pause,
      play: vi.fn(),
      begin_scrub: vi.fn(),
      update_scrub: vi.fn(),
      commit_scrub: vi.fn(),
      cancel_scrub: vi.fn(),
      seek_to: vi.fn(),
      set_playback_rate: vi.fn(),
      set_volume: vi.fn(),
      step_frame: vi.fn(),
      toggle_captions: vi.fn(),
      toggle_playback: player_toggle,
    }));
    return <div data-testid="summary-player" />;
  }),
}));

describe("SummaryMediaShelf", () => {
  beforeEach(() => {
    player_render.mockClear();
    player_pause.mockClear();
    player_toggle.mockClear();
  });

  it("keeps an independent player mounted while the shelf is collapsed", () => {
    const on_expanded_change = vi.fn();
    render(
      <SummaryMediaShelf
        asset={create_asset()}
        expanded={false}
        on_expanded_change={on_expanded_change}
        transcript={null}
      />,
    );

    expect(screen.getByTestId("summary-player").parentElement).toHaveClass(
      "size-px",
    );
    fireEvent.click(screen.getByRole("button", { name: "播放解析视频" }));
    fireEvent.click(screen.getByRole("button", { name: "展开解析视频" }));

    expect(player_toggle).toHaveBeenCalledOnce();
    expect(on_expanded_change).toHaveBeenCalledWith(true);
  });

  it("reports precise time in the media shelf", () => {
    render(
      <SummaryMediaShelf
        asset={create_asset()}
        expanded
        on_expanded_change={vi.fn()}
        transcript={null}
      />,
    );
    const on_time_change = player_render.mock.lastCall?.[0]
      .on_time_change as (seconds: number) => void;

    act(() => on_time_change(65.432));
    expect(screen.getByLabelText("解析视频当前时间")).toHaveTextContent(
      "00:01:05.432",
    );
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
    title: "解析视频",
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
