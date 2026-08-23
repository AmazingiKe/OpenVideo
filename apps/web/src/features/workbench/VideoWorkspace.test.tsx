import { createRef, forwardRef } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VideoWorkspace } from "./VideoWorkspace";
import type { PlayerHandle } from "../player/Player";
import type { MediaAsset } from "../../shared/types";

vi.mock("../player/Player", () => ({
  Player: forwardRef(function Player() {
    return <div data-testid="player" />;
  }),
}));

const ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f";

describe("VideoWorkspace", () => {
  it("keeps transport controls below the video", () => {
    const seek_to = vi.fn();
    const toggle_playback = vi.fn();
    const set_volume = vi.fn();
    const toggle_muted = vi.fn();
    const set_playback_rate = vi.fn();
    const toggle_picture_in_picture = vi.fn();
    const toggle_fullscreen = vi.fn();
    const player_ref = createRef<PlayerHandle>();
    player_ref.current = {
      current_time: () => 20,
      seek_to,
      toggle_playback,
      set_volume,
      toggle_muted,
      set_playback_rate,
      toggle_picture_in_picture,
      toggle_fullscreen,
    };
    const workspace = render(
      <VideoWorkspace
        asset={create_asset()}
        transcript={null}
        markers={[]}
        player_ref={player_ref}
        on_time_change={vi.fn()}
      />,
    );

    const controls = within(workspace.container);
    const workspace_stage =
      workspace.container.querySelector(".workspace_stage");
    expect(workspace_stage).toContainElement(controls.getByTestId("player"));
    expect(
      controls.getByRole("heading", { name: "课程视频" }),
    ).toBeInTheDocument();
    expect(controls.getByText("讲师")).toBeInTheDocument();
    expect(controls.queryByText("课程简介")).not.toBeInTheDocument();
    expect(controls.queryByText("1920 × 1080")).not.toBeInTheDocument();
    fireEvent.click(controls.getByRole("button", { name: "后退 10 秒" }));
    fireEvent.click(controls.getByRole("button", { name: "后退 10 秒" }));
    fireEvent.click(controls.getByRole("button", { name: "播放" }));
    fireEvent.click(controls.getByRole("button", { name: "快进 10 秒" }));
    fireEvent.click(controls.getByRole("button", { name: "静音" }));
    fireEvent.click(controls.getByRole("button", { name: "进入全屏" }));
    fireEvent.pointerDown(
      controls.getByRole("button", { name: "播放设置，当前 1 倍速" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "1.5×" }));

    expect(seek_to).toHaveBeenNthCalledWith(1, 10);
    expect(seek_to).toHaveBeenNthCalledWith(2, 0);
    expect(toggle_playback).toHaveBeenCalledOnce();
    expect(seek_to).toHaveBeenNthCalledWith(3, 10);
    expect(toggle_muted).toHaveBeenCalledOnce();
    expect(toggle_fullscreen).toHaveBeenCalledOnce();
    expect(set_playback_rate).toHaveBeenCalledWith(1.5);
    expect(controls.getByRole("button", { name: "进入画中画" })).toBeDisabled();
    expect(controls.getByRole("slider", { name: "音量" })).toBeInTheDocument();
    expect(controls.getByLabelText("当前音量")).toHaveTextContent("100%");
  });
});

function create_asset(): MediaAsset {
  return {
    asset_id: ASSET_ID,
    media_type: "video",
    source_url: "https://www.bilibili.com/video/BV1xx411c7mD",
    source_platform: "bilibili",
    source_video_id: "BV1xx411c7mD",
    title: "课程视频",
    author_name: "讲师",
    description: "课程简介",
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
