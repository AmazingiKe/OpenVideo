import { forwardRef, useImperativeHandle } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayerHandle } from "@/features/player/Player";
import type { MediaAsset } from "@/shared/types";
import { FloatingSummaryPlayer } from "./FloatingSummaryPlayer";

const player_render = vi.hoisted(() => vi.fn());
const player_toggle = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ setQueryData: vi.fn() }),
}));

vi.mock("@/shared/api", () => ({
  ensure_thumbnail_storyboard: vi.fn(() => new Promise(() => undefined)),
  media_url: (path: string) => path,
}));

vi.mock("@/features/player/Player", () => ({
  Player: forwardRef<PlayerHandle, Record<string, unknown>>(
    function Player(props, ref) {
      player_render(props);
      useImperativeHandle(ref, () => ({
        current_time: () => 0,
        pause: vi.fn(),
        play: vi.fn(),
        begin_scrub: vi.fn(),
        update_scrub: vi.fn(),
        commit_scrub: vi.fn(),
        cancel_scrub: vi.fn(),
        seek_to: vi.fn(),
        set_volume: vi.fn(),
        step_frame: vi.fn(),
        toggle_captions: vi.fn(),
        toggle_playback: player_toggle,
      }));
      return <div data-testid="summary-player" />;
    },
  ),
}));

describe("FloatingSummaryPlayer", () => {
  beforeEach(() => {
    player_render.mockClear();
    player_toggle.mockClear();
  });

  afterEach(() => vi.restoreAllMocks());

  it("keeps the player mounted while minimized and can reopen it", () => {
    const on_open_change = vi.fn();
    render(
      <FloatingSummaryPlayer
        asset={create_asset()}
        geometry={null}
        open={false}
        on_geometry_change={vi.fn()}
        on_open_change={on_open_change}
        transcript={null}
      />,
    );

    expect(screen.getByTestId("summary-player").closest("section")).toHaveClass(
      "size-px",
    );
    fireEvent.click(screen.getByRole("button", { name: "参考视频" }));

    expect(on_open_change).toHaveBeenCalledWith(true);
  });

  it("controls playback without adding a duplicate precision overlay", () => {
    const on_open_change = vi.fn();
    render(
      <FloatingSummaryPlayer
        asset={create_asset()}
        geometry={null}
        open
        on_geometry_change={vi.fn()}
        on_open_change={on_open_change}
        transcript={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "播放总结参考视频" }));
    fireEvent.click(screen.getByRole("button", { name: "最小化参考视频" }));

    expect(player_render.mock.lastCall?.[0]).toMatchObject({
      precision_controls_enabled: false,
    });
    expect(
      screen.queryByLabelText("总结参考视频当前时间"),
    ).not.toBeInTheDocument();
    expect(player_toggle).toHaveBeenCalledOnce();
    expect(on_open_change).toHaveBeenCalledWith(false);
  });

  it("moves and resizes within the available summary workspace", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 700,
      height: 700,
      left: 0,
      right: 1_000,
      top: 0,
      width: 1_000,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const on_geometry_change = vi.fn();
    render(
      <FloatingSummaryPlayer
        asset={create_asset()}
        geometry={{ x: 100, y: 100, width: 400, height: 280 }}
        open
        on_geometry_change={on_geometry_change}
        on_open_change={vi.fn()}
        transcript={null}
      />,
    );

    const move_handle = screen.getByRole("button", {
      name: "移动参考视频窗口",
    });
    fireEvent.pointerDown(move_handle, {
      button: 0,
      clientX: 100,
      clientY: 100,
      pointerId: 1,
    });
    fireEvent.pointerMove(move_handle, {
      clientX: 220,
      clientY: 180,
      pointerId: 1,
    });
    fireEvent.pointerUp(move_handle, {
      clientX: 220,
      clientY: 180,
      pointerId: 1,
    });

    expect(on_geometry_change).toHaveBeenLastCalledWith({
      x: 220,
      y: 180,
      width: 400,
      height: 280,
    });

    const resize_handle = screen.getByRole("button", {
      name: "调整参考视频窗口大小",
    });
    fireEvent.pointerDown(resize_handle, {
      button: 0,
      clientX: 400,
      clientY: 280,
      pointerId: 2,
    });
    fireEvent.pointerMove(resize_handle, {
      clientX: 500,
      clientY: 340,
      pointerId: 2,
    });
    fireEvent.pointerUp(resize_handle, {
      clientX: 500,
      clientY: 340,
      pointerId: 2,
    });

    expect(on_geometry_change).toHaveBeenLastCalledWith({
      x: 220,
      y: 180,
      width: 500,
      height: 340,
    });

    const northwest_resize_handle = screen.getByRole("button", {
      name: "向左上调整参考视频窗口大小",
    });
    fireEvent.pointerDown(northwest_resize_handle, {
      button: 0,
      clientX: 220,
      clientY: 180,
      pointerId: 3,
    });
    fireEvent.pointerMove(northwest_resize_handle, {
      clientX: 160,
      clientY: 140,
      pointerId: 3,
    });
    fireEvent.pointerUp(northwest_resize_handle, {
      clientX: 160,
      clientY: 140,
      pointerId: 3,
    });

    expect(on_geometry_change).toHaveBeenLastCalledWith({
      x: 160,
      y: 140,
      width: 560,
      height: 380,
    });
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
    title: "课程视频",
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
