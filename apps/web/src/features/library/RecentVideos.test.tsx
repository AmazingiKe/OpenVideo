import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RecentVideos } from "./RecentVideos";
import { STORY_ASSETS } from "./library_story_fixtures";

const ASSET = {
  ...STORY_ASSETS[0],
  duration_seconds: 120,
  playback: {
    position_seconds: 30,
    playback_rate: 1.5,
    last_watched_at: "2026-10-17T00:00:00Z",
  },
};

describe("RecentVideos", () => {
  it("shows saved time and rate and opens the chosen video", () => {
    const on_open = vi.fn();
    render(
      <RecentVideos assets={[ASSET]} on_open={on_open} on_retry={vi.fn()} />,
    );

    expect(screen.getByText("已看 00:30")).toBeInTheDocument();
    expect(screen.getByText("02:00 · 1.5 倍速")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "25",
    );
    fireEvent.click(
      screen.getByRole("button", { name: `继续观看：${ASSET.title}` }),
    );
    expect(on_open).toHaveBeenCalledWith(ASSET);
  });

  it("offers replay for a completed video and handles unknown duration", () => {
    const completed = { ...ASSET, duration_seconds: 30 };
    const unknown = {
      ...ASSET,
      asset_id: STORY_ASSETS[1].asset_id,
      title: "时长未知的视频",
      duration_seconds: null,
    };
    render(
      <RecentVideos
        assets={[completed, unknown]}
        on_open={vi.fn()}
        on_retry={vi.fn()}
      />,
    );

    expect(screen.getByText("已看完")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `重新观看：${ASSET.title}` }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(screen.getByText("时长未知 · 1.5 倍速")).toBeInTheDocument();
  });

  it("shows loading and empty states separately", () => {
    const { rerender } = render(
      <RecentVideos assets={[]} loading on_open={vi.fn()} on_retry={vi.fn()} />,
    );
    expect(
      screen.getByRole("status", { name: "正在读取观看记录" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("尚无观看记录")).not.toBeInTheDocument();

    rerender(<RecentVideos assets={[]} on_open={vi.fn()} on_retry={vi.fn()} />);
    expect(screen.getByText("尚无观看记录")).toBeInTheDocument();
  });

  it("reports failure and retries without blocking the rest of the library", () => {
    const on_retry = vi.fn();
    render(
      <RecentVideos
        assets={[]}
        error="资料库不可用"
        on_open={vi.fn()}
        on_retry={on_retry}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("资料库不可用");
    expect(screen.queryByText("尚无观看记录")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(on_retry).toHaveBeenCalledOnce();
  });
});
