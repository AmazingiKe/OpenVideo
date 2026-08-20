import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { describe, expect, it, vi } from "vitest";

import { App } from "./App";
import {
  get_health,
  get_markers,
  get_segments,
  get_transcript,
  list_assets,
} from "./shared/api";


const ASSET_ID = "asset-0123456789abcdef0123456789abcdef";

vi.mock("./shared/api", () => ({
  analyze_asset: vi.fn(),
  create_download: vi.fn(),
  create_marker: vi.fn(),
  delete_marker: vi.fn(),
  get_health: vi.fn(),
  get_markers: vi.fn(),
  get_segments: vi.fn(),
  get_transcript: vi.fn(),
  list_assets: vi.fn(),
  media_url: (path: string) => path,
  probe_source: vi.fn(),
  update_marker: vi.fn(),
}));

vi.mock("./features/player/Player", () => ({
  Player: forwardRef(function Player(_, ref) {
    useImperativeHandle(ref, () => ({ current_time: () => 0, seek_to: vi.fn() }));
    return <div data-testid="player" />;
  }),
}));

describe("App", () => {
  it("keeps the library, video and inspector together in one workbench", async () => {
    vi.mocked(get_health).mockResolvedValue({
      status: "ready",
      dependencies: { yt_dlp: true, ffmpeg: true, ffprobe: true },
    });
    vi.mocked(list_assets).mockResolvedValue([{
      asset_id: ASSET_ID,
      source_url: "https://www.bilibili.com/video/BV1xx411c7mD",
      source_platform: "bilibili",
      source_video_id: "BV1xx411c7mD",
      title: "演示视频",
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
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    }]);
    vi.mocked(get_markers).mockResolvedValue([]);
    vi.mocked(get_segments).mockResolvedValue([]);
    vi.mocked(get_transcript).mockResolvedValue({
      asset_id: ASSET_ID,
      language: "zh",
      created_at: "2026-01-01T00:00:00Z",
      segments: [{ start_seconds: 5, end_seconds: 8, text: "可回跳的转写。" }],
    });

    render(<App />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "演示视频" })).toBeInTheDocument());
    expect(screen.getByLabelText("媒体库")).toBeInTheDocument();
    expect(screen.getByLabelText("视频工作区")).toBeInTheDocument();
    expect(screen.getByLabelText("视频检查器")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "转写" }));
    expect(screen.getByText("可回跳的转写。")).toBeInTheDocument();
  });
});
