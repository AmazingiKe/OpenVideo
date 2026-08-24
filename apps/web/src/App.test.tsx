import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import {
  create_download,
  delete_douyin_download_account,
  get_analysis_page_settings,
  get_health,
  get_douyin_download_account,
  get_library,
  get_preferences,
  import_douyin_download_account_from_browser,
  get_markers,
  get_segments,
  get_transcript,
  list_assets,
  list_ai_models,
  list_analysis_strategies,
  list_transcription_models,
  probe_source,
  save_douyin_download_account,
  test_douyin_download_account,
} from "./shared/api";
import type { MediaAsset } from "./shared/types";

const ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f";

vi.mock("./shared/api", () => ({
  analyze_asset: vi.fn(),
  create_download: vi.fn(),
  create_marker: vi.fn(),
  delete_douyin_download_account: vi.fn(),
  delete_marker: vi.fn(),
  get_health: vi.fn(),
  get_douyin_download_account: vi.fn(),
  get_analysis_page_settings: vi.fn(),
  get_library: vi.fn(),
  get_preferences: vi.fn(),
  import_douyin_download_account_from_browser: vi.fn(),
  get_markers: vi.fn(),
  get_segments: vi.fn(),
  get_transcript: vi.fn(),
  list_assets: vi.fn(),
  list_ai_models: vi.fn(),
  list_analysis_strategies: vi.fn(),
  list_transcription_models: vi.fn(),
  media_url: (path: string) => path,
  probe_source: vi.fn(),
  save_douyin_download_account: vi.fn(),
  select_directory: vi.fn(),
  test_ai_model: vi.fn(),
  test_douyin_download_account: vi.fn(),
  transcribe_asset: vi.fn(),
  update_analysis_page_settings: vi.fn(),
  update_transcript_segment: vi.fn(),
  update_marker: vi.fn(),
  update_preferences: vi.fn(),
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
      tools_directory: null,
      models_directory: null,
      default_transcription: {
        engine: "faster-whisper",
        model: "small",
        language: "zh",
        device: "cpu",
        compute_type: "int8",
      },
      ai_models: [],
      managed_fields: [],
      library_path_managed: false,
    });
    vi.mocked(get_analysis_page_settings).mockResolvedValue({
      asset_library_size_percent: 14,
      asset_library_collapsed: false,
      tool_panel_size_percent: 16,
      tool_panel_collapsed: false,
      open_tool_sections: ["video_information"],
    });
    vi.mocked(list_ai_models).mockResolvedValue([]);
    vi.mocked(list_analysis_strategies).mockResolvedValue([]);
    vi.mocked(list_transcription_models).mockResolvedValue([]);
    vi.mocked(get_douyin_download_account).mockResolvedValue(null);
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
      segments: [
        {
          start_seconds: 5,
          end_seconds: 8,
          text: "可回跳的转写。",
          emotion: null,
          audio_events: [],
        },
      ],
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
    expect(screen.getByLabelText("视频库")).toBeInTheDocument();
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

    expect(screen.getByText("Canvas Timeline")).toBeInTheDocument();
  });

  it("selects the Douyin video opened from a search result", async () => {
    vi.mocked(get_health).mockResolvedValue({
      status: "ready",
      dependencies: { yt_dlp: true, ffmpeg: true, ffprobe: true },
    });
    vi.mocked(probe_source).mockResolvedValue({
      platform: "douyin",
      is_playlist: false,
      title: "抖音搜索结果视频",
      entries: [
        {
          source_video_id: "7676366977263042789",
          url: "https://www.douyin.com/video/7676366977263042789",
          title: "抖音搜索结果视频",
          duration_seconds: 30,
          uploader: "示例作者",
        },
      ],
      truncated: false,
      total_count: 1,
    });

    render(<App />);

    const source_url =
      "https://www.douyin.com/search/dy?modal_id=7676366977263042789";
    fireEvent.change(await screen.findByLabelText("视频或播放列表地址"), {
      target: { value: source_url },
    });
    fireEvent.click(screen.getByRole("button", { name: "检测链接" }));

    await waitFor(() => expect(probe_source).toHaveBeenCalledWith(source_url));
    expect(await screen.findByRole("checkbox")).toBeChecked();
    expect(screen.getByRole("button", { name: "下载 1 个视频" })).toBeEnabled();
  });

  it("saves and tests a Douyin download account", async () => {
    vi.mocked(get_health).mockResolvedValue({
      status: "ready",
      dependencies: { yt_dlp: true, ffmpeg: true, ffprobe: true },
    });
    const saved_account = {
      account_id: "account-0198d12345677890abcdef1234567890",
      platform: "douyin" as const,
      display_name: "抖音账号",
      status: "untested" as const,
      last_tested_at: null,
      updated_at: "2026-08-24T08:30:00Z",
    };
    vi.mocked(save_douyin_download_account).mockResolvedValue(saved_account);
    vi.mocked(test_douyin_download_account).mockResolvedValue({
      ...saved_account,
      status: "available",
      last_tested_at: "2026-08-24T08:31:00Z",
    });
    vi.mocked(delete_douyin_download_account).mockResolvedValue();

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "连接账号" }));
    fireEvent.change(screen.getByLabelText("抖音 Cookie"), {
      target: { value: "ttwid=device-token; sessionid=login-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存 Cookie" }));

    await waitFor(() =>
      expect(save_douyin_download_account).toHaveBeenCalledWith(
        "ttwid=device-token; sessionid=login-token",
      ),
    );
    expect(await screen.findByText("待测试")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "测试账号" }));
    await waitFor(() =>
      expect(test_douyin_download_account).toHaveBeenCalledWith(undefined),
    );
    expect(await screen.findByText("可用")).toBeInTheDocument();
  });

  it("imports a logged-in Douyin account from Edge", async () => {
    vi.mocked(get_health).mockResolvedValue({
      status: "ready",
      dependencies: { yt_dlp: true, ffmpeg: true, ffprobe: true },
    });
    vi.mocked(import_douyin_download_account_from_browser).mockResolvedValue({
      account_id: "account-0198d12345677890abcdef1234567890",
      platform: "douyin",
      display_name: "抖音账号",
      status: "available",
      last_tested_at: "2026-08-24T08:31:00Z",
      updated_at: "2026-08-24T08:31:00Z",
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "连接账号" }));
    fireEvent.click(screen.getByRole("button", { name: "从浏览器导入" }));

    await waitFor(() =>
      expect(import_douyin_download_account_from_browser).toHaveBeenCalledWith(
        "edge",
        undefined,
      ),
    );
    expect(await screen.findByText("可用")).toBeInTheDocument();
  });

  it("shows relogin when the saved Douyin account expires", async () => {
    vi.mocked(get_health).mockResolvedValue({
      status: "ready",
      dependencies: { yt_dlp: true, ffmpeg: true, ffprobe: true },
    });
    vi.mocked(get_douyin_download_account).mockResolvedValue({
      account_id: "account-0198d12345677890abcdef1234567890",
      platform: "douyin",
      display_name: "抖音账号",
      status: "expired",
      last_tested_at: "2026-08-24T08:30:00Z",
      updated_at: "2026-08-24T08:30:00Z",
    });

    render(<App />);

    expect(await screen.findByText("登录状态已过期")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新登录" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "测试账号" })).toBeDisabled();
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
      status === "ready"
        ? ASSET_ID
        : status === "downloading"
          ? "01890f4c-7a2b-7cc2-98c4-dc0c0c073990"
          : "01890f4c-7a2b-7cc2-98c4-dc0c0c073991",
    media_type: "video",
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
