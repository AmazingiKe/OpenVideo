import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import {
  create_download,
  get_health,
  get_library,
  get_preferences,
  get_markers,
  get_segments,
  get_transcript,
  list_assets,
  probe_source,
} from "./shared/api";
import type { MediaAsset } from "./shared/types";

const ASSET_ID = "asset-0123456789abcdef0123456789abcdef";

vi.mock("./shared/api", () => ({
  analyze_asset: vi.fn(),
  create_download: vi.fn(),
  create_marker: vi.fn(),
  delete_marker: vi.fn(),
  get_health: vi.fn(),
  get_library: vi.fn(),
  get_preferences: vi.fn(),
  get_markers: vi.fn(),
  get_segments: vi.fn(),
  get_transcript: vi.fn(),
  list_assets: vi.fn(),
  media_url: (path: string) => path,
  probe_source: vi.fn(),
  select_library_directory: vi.fn(),
  transcribe_asset: vi.fn(),
  update_transcript_segment: vi.fn(),
  update_marker: vi.fn(),
}));

vi.mock("./features/player/Player", () => ({
  Player: forwardRef(function Player(_, ref) {
    useImperativeHandle(ref, () => ({
      current_time: () => 0,
      seek_to: vi.fn(),
    }));
    return <div data-testid="player" />;
  }),
}));

describe("App", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    vi.mocked(get_library).mockResolvedValue({
      library_id: "library-0123456789abcdef0123456789abcdef",
      name: "测试资料库",
      root_path: "D:\\OpenVideo",
      format_version: 1,
      created_at: "2026-01-01T00:00:00Z",
    });
    vi.mocked(get_preferences).mockResolvedValue({
      ffmpeg_directory: null,
      whisper_model: "small",
      whisper_model_path: null,
      whisper_language: "zh",
      whisper_compute_type: "int8",
      openai_base_url: "https://api.openai.com/v1",
      openai_api_key: null,
      vision_model: "gpt-5.6-terra",
      managed_fields: [],
      library_path_managed: false,
    });
  });

  it("shows the library setup before mounting workspace providers", async () => {
    vi.mocked(get_library).mockResolvedValue(null);
    vi.mocked(list_assets).mockClear();
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "选择 OpenVideo 资料库" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("请选择或创建资料库");
    expect(screen.queryByText("无法读取上次的资料库")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/initialize");
    expect(list_assets).not.toHaveBeenCalled();
  });

  it("redirects the initialization route when a library is already open", async () => {
    window.history.replaceState(null, "", "/initialize");
    vi.mocked(get_health).mockResolvedValue({
      status: "ready",
      dependencies: { yt_dlp: true, ffmpeg: true, ffprobe: true },
    });

    render(<App />);

    await waitFor(() => expect(window.location.pathname).toBe("/downloads"));
  });
  it("keeps the library, video and timeline together in one workbench", async () => {
    vi.mocked(get_health).mockResolvedValue({
      status: "ready",
      dependencies: { yt_dlp: true, ffmpeg: true, ffprobe: true },
    });
    vi.mocked(list_assets).mockResolvedValue([
      create_asset({
        status: "ready",
        title: "演示视频",
        playback_url: "/stream",
      }),
      create_asset({
        status: "downloading",
        title: "下载中的视频",
        playback_url: null,
      }),
      create_asset({
        status: "failed",
        title: "失败的视频",
        playback_url: null,
      }),
    ]);
    vi.mocked(get_markers).mockResolvedValue([]);
    vi.mocked(get_segments).mockResolvedValue([]);
    vi.mocked(get_transcript).mockResolvedValue({
      asset_id: ASSET_ID,
      language: "zh",
      created_at: "2026-01-01T00:00:00Z",
      segments: [{ start_seconds: 5, end_seconds: 8, text: "可回跳的转写。" }],
    });
    vi.mocked(probe_source).mockResolvedValue({
      platform: "bilibili",
      is_playlist: true,
      title: "已检测的视频",
      entries: [
        {
          source_video_id: "BV1xx411c7mD",
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          title: "已检测的视频",
          duration_seconds: 60,
          uploader: "示例作者",
        },
        {
          source_video_id: "BV1yy411c7mD",
          url: "https://www.bilibili.com/video/BV1yy411c7mD",
          title: "同一合集的其他视频",
          duration_seconds: 120,
          uploader: "示例作者",
        },
      ],
      truncated: false,
      total_count: 2,
    });

    render(<App />);

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "下载在线视频，稍后集中处理" }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "开始分析" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "检测链接" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("视频或播放列表地址"), {
      target: { value: "https://www.bilibili.com/video/BV1xx411c7mD" },
    });
    fireEvent.click(screen.getByRole("button", { name: "检测链接" }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "已检测的视频" }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "下载 1 个视频" }),
    ).toBeInTheDocument();
    const entries = screen.getAllByRole("checkbox");
    expect(entries[0]).toBeChecked();
    expect(entries[1]).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    expect(
      screen.getByRole("button", { name: "下载 2 个视频" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(
      screen.getByRole("button", { name: "下载 0 个视频" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "当前视频" }));
    expect(
      screen.getByRole("button", { name: "下载 1 个视频" }),
    ).toBeInTheDocument();
    expect(create_download).not.toHaveBeenCalled();
    const download_module = screen.getByRole("link", { name: "下载" });
    expect(download_module).toHaveAttribute("aria-current", "page");

    fireEvent.click(screen.getByRole("link", { name: "分析" }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "演示视频" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("媒体库")).toBeInTheDocument();
    expect(screen.getByLabelText("视频工作区")).toBeInTheDocument();
    expect(screen.getByLabelText("剪辑时间轴")).toBeInTheDocument();
    expect(screen.queryByText("下载中的视频")).not.toBeInTheDocument();
    expect(screen.queryByText("失败的视频")).not.toBeInTheDocument();

    expect(window.location.pathname).toBe("/analysis");
    expect(download_module).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "分析" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    expect(screen.getByText("可回跳的转写。")).toBeInTheDocument();
  });

  it("redirects unknown paths to downloads", async () => {
    window.history.replaceState(null, "", "/missing");
    vi.mocked(get_health).mockResolvedValue({
      status: "ready",
      dependencies: { yt_dlp: true, ffmpeg: true, ffprobe: true },
    });

    render(<App />);

    await waitFor(() => expect(window.location.pathname).toBe("/downloads"));
    expect(screen.getByRole("link", { name: "下载" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("does not load media data on the settings page", async () => {
    window.history.replaceState(null, "", "/settings");
    vi.mocked(list_assets).mockClear();

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "配置 OpenVideo 工作环境" }),
    ).toBeInTheDocument();
    expect(list_assets).not.toHaveBeenCalled();
  });
});

function create_asset({
  status,
  title,
  playback_url,
}: {
  status: "ready" | "downloading" | "failed";
  title: string;
  playback_url: string | null;
}): MediaAsset {
  return {
    asset_id:
      status === "ready" ? ASSET_ID : `asset-${status}000000000000000000000000`,
    source_url: "https://www.bilibili.com/video/BV1xx411c7mD",
    source_platform: "bilibili",
    source_video_id: "BV1xx411c7mD",
    title,
    author_name: "作者",
    description: null,
    duration_seconds: 60,
    width: 1920,
    height: 1080,
    video_codec: "h264",
    audio_codec: "aac",
    status,
    error_message: null,
    playback_url,
    thumbnail_url: null,
    thumbnail_storyboard: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}
