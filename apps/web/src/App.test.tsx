import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import {
  create_download,
  create_download_account_login_session,
  delete_download_account_login_session,
  delete_download_account,
  get_markers_page_settings,
  get_health,
  get_download_accounts,
  get_library,
  get_preferences,
  import_download_account_from_browser,
  get_markers,
  get_segments,
  get_transcript,
  list_assets,
  list_ai_models,
  list_analysis_strategies,
  list_transcription_models,
  probe_source,
  save_download_account,
  test_download_account,
} from "./shared/api";
import type { DownloadAccountLoginSession, MediaAsset } from "./shared/types";

const ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f";

vi.mock("./shared/api", () => ({
  analyze_asset: vi.fn(),
  create_download: vi.fn(),
  create_download_account_login_session: vi.fn(),
  create_marker: vi.fn(),
  delete_download_account: vi.fn(),
  delete_download_account_login_session: vi.fn(),
  delete_marker: vi.fn(),
  get_health: vi.fn(),
  get_download_accounts: vi.fn(),
  get_download_account_login_session: vi.fn(),
  get_markers_page_settings: vi.fn(),
  get_library: vi.fn(),
  get_preferences: vi.fn(),
  import_download_account_from_browser: vi.fn(),
  get_markers: vi.fn(),
  get_segments: vi.fn(),
  get_transcript: vi.fn(),
  list_assets: vi.fn(),
  list_ai_models: vi.fn(),
  list_analysis_strategies: vi.fn(),
  list_transcription_models: vi.fn(),
  media_url: (path: string) => path,
  probe_source: vi.fn(),
  save_download_account: vi.fn(),
  select_directory: vi.fn(),
  test_ai_model: vi.fn(),
  test_download_account: vi.fn(),
  transcribe_asset: vi.fn(),
  update_markers_page_settings: vi.fn(),
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
      format_version: 2,
      index_issues: [],
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
    vi.mocked(get_markers_page_settings).mockResolvedValue({
      asset_library_size_percent: 14,
      agent_panel_size_percent: 24,
      asset_library_collapsed: false,
      tool_panel_size_percent: 16,
      tool_panel_collapsed: false,
      left_panel_tab: "video",
      open_tool_sections: ["video_information"],
    });
    vi.mocked(list_ai_models).mockResolvedValue([]);
    vi.mocked(list_analysis_strategies).mockResolvedValue([]);
    vi.mocked(list_transcription_models).mockResolvedValue([]);
    vi.mocked(list_assets).mockResolvedValue([]);
    vi.mocked(get_download_accounts).mockResolvedValue([]);
    vi.mocked(create_download_account_login_session).mockRejectedValue(
      new Error("专用登录窗口不可用"),
    );
    vi.mocked(delete_download_account_login_session).mockResolvedValue();
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

    fireEvent.click(screen.getByRole("link", { name: "标记" }));
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

    expect(window.location.pathname).toBe("/markers");
    expect(download_module).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "标记" })).toHaveAttribute(
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

  it("saves and tests a Bilibili download account", async () => {
    vi.mocked(get_health).mockResolvedValue({
      status: "ready",
      dependencies: { yt_dlp: true, ffmpeg: true, ffprobe: true },
    });
    const saved_account = {
      account_id: "account-0198d12345677890abcdef1234567890",
      platform: "bilibili" as const,
      display_name: "Bilibili 账号",
      status: "untested" as const,
      last_tested_at: null,
      updated_at: "2026-08-24T08:30:00Z",
    };
    vi.mocked(save_download_account).mockResolvedValue(saved_account);
    vi.mocked(test_download_account).mockResolvedValue({
      ...saved_account,
      status: "available",
      last_tested_at: "2026-08-24T08:31:00Z",
    });
    vi.mocked(delete_download_account).mockResolvedValue();

    render(<App />);

    const bilibili_account = await screen.findByRole("region", {
      name: "Bilibili",
    });
    fireEvent.click(
      within(bilibili_account).getByRole("button", { name: "连接账号" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "其他连接方式" }),
    );
    fireEvent.change(screen.getByLabelText("手动粘贴 Bilibili Cookie"), {
      target: { value: "SESSDATA=login-token; bili_jct=csrf-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存 Cookie" }));

    await waitFor(() =>
      expect(save_download_account).toHaveBeenCalledWith(
        "bilibili",
        "SESSDATA=login-token; bili_jct=csrf-token",
      ),
    );
    expect(await screen.findByText("待测试")).toBeInTheDocument();

    fireEvent.click(
      within(bilibili_account).getByRole("button", { name: "测试" }),
    );
    await waitFor(() =>
      expect(test_download_account).toHaveBeenCalledWith("bilibili", undefined),
    );
    expect(await screen.findByText("可用")).toBeInTheDocument();
  });

  it("connects a Douyin account through the dedicated login window", async () => {
    vi.mocked(get_health).mockResolvedValue({
      status: "ready",
      dependencies: { yt_dlp: true, ffmpeg: true, ffprobe: true },
    });
    const account = {
      account_id: "account-0198d12345677890abcdef1234567890",
      platform: "douyin" as const,
      display_name: "抖音账号",
      status: "available" as const,
      last_tested_at: "2026-08-24T08:31:00Z",
      updated_at: "2026-08-24T08:31:00Z",
    };
    vi.mocked(create_download_account_login_session).mockResolvedValue({
      login_id: "login-0198d12345677890abcdef1234567890",
      platform: "douyin",
      stage: "complete",
      message: "登录成功",
      account,
    });

    render(<App />);

    const douyin_account = await screen.findByRole("region", { name: "抖音" });
    fireEvent.click(
      within(douyin_account).getByRole("button", { name: "连接账号" }),
    );

    await waitFor(() =>
      expect(create_download_account_login_session).toHaveBeenCalledWith(
        "douyin",
      ),
    );
    expect(await screen.findByText("可用")).toBeInTheDocument();
    expect(delete_download_account_login_session).toHaveBeenCalledWith(
      "login-0198d12345677890abcdef1234567890",
    );
  });

  it("cleans up a dedicated login cancelled before session creation returns", async () => {
    vi.mocked(get_health).mockResolvedValue({
      status: "ready",
      dependencies: { yt_dlp: true, ffmpeg: true, ffprobe: true },
    });
    let resolve_login!: (session: DownloadAccountLoginSession) => void;
    vi.mocked(create_download_account_login_session).mockReturnValue(
      new Promise((resolve) => {
        resolve_login = resolve;
      }),
    );

    render(<App />);

    const bilibili_account = await screen.findByRole("region", {
      name: "Bilibili",
    });
    fireEvent.click(
      within(bilibili_account).getByRole("button", { name: "连接账号" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "取消登录" }));
    resolve_login({
      login_id: "login-0198d12345677890abcdef1234567890",
      platform: "bilibili",
      stage: "waiting",
      message: "请在专用浏览器窗口完成登录",
      account: null,
    });

    await waitFor(() =>
      expect(delete_download_account_login_session).toHaveBeenCalledWith(
        "login-0198d12345677890abcdef1234567890",
      ),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("imports a logged-in Douyin account from Edge", async () => {
    vi.mocked(get_health).mockResolvedValue({
      status: "ready",
      dependencies: { yt_dlp: true, ffmpeg: true, ffprobe: true },
    });
    vi.mocked(import_download_account_from_browser).mockResolvedValue({
      account_id: "account-0198d12345677890abcdef1234567890",
      platform: "douyin",
      display_name: "抖音账号",
      status: "available",
      last_tested_at: "2026-08-24T08:31:00Z",
      updated_at: "2026-08-24T08:31:00Z",
    });

    render(<App />);

    const douyin_account = await screen.findByRole("region", { name: "抖音" });
    fireEvent.click(
      within(douyin_account).getByRole("button", { name: "连接账号" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "其他连接方式" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "导入" }));

    await waitFor(() =>
      expect(import_download_account_from_browser).toHaveBeenCalledWith(
        "douyin",
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
    vi.mocked(get_download_accounts).mockResolvedValue([
      {
        account_id: "account-0198d12345677890abcdef1234567890",
        platform: "douyin",
        display_name: "抖音账号",
        status: "expired",
        last_tested_at: "2026-08-24T08:30:00Z",
        updated_at: "2026-08-24T08:30:00Z",
      },
    ]);

    render(<App />);

    expect(await screen.findByText("登录状态已过期")).toBeInTheDocument();
    const douyin_account = screen.getByRole("region", { name: "抖音" });
    expect(
      within(douyin_account).getByRole("button", { name: "重新登录" }),
    ).toBeEnabled();
    expect(
      within(douyin_account).getByRole("button", { name: "测试" }),
    ).toBeDisabled();
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

  it("preserves workspace input while switching modules", async () => {
    vi.mocked(get_health).mockResolvedValue({
      status: "ready",
      dependencies: { yt_dlp: true, ffmpeg: true, ffprobe: true },
    });
    vi.mocked(list_assets).mockResolvedValue([]);
    render(<App />);

    const source_input = await screen.findByLabelText("视频或播放列表地址");
    fireEvent.change(source_input, {
      target: { value: "https://example.com/preserved-video" },
    });
    fireEvent.click(screen.getByRole("link", { name: "标记" }));
    await waitFor(() => expect(window.location.pathname).toBe("/markers"));
    fireEvent.click(screen.getByRole("link", { name: "下载" }));

    expect(await screen.findByLabelText("视频或播放列表地址")).toHaveValue(
      "https://example.com/preserved-video",
    );
  });

  it("unmounts the markers player while another workspace is active", async () => {
    vi.mocked(get_health).mockResolvedValue({
      status: "ready",
      dependencies: { yt_dlp: true, ffmpeg: true, ffprobe: true },
    });
    vi.mocked(list_assets).mockResolvedValue([
      create_asset({
        status: "ready",
        title: "播放器生命周期测试",
        playback_url: "/stream",
      }),
    ]);
    vi.mocked(get_markers).mockResolvedValue([]);
    vi.mocked(get_segments).mockResolvedValue([]);
    vi.mocked(get_transcript).mockResolvedValue({
      asset_id: ASSET_ID,
      language: "zh",
      created_at: "2026-01-01T00:00:00Z",
      segments: [],
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "标记" }));
    expect(await screen.findByTestId("player")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "下载" }));
    await waitFor(() =>
      expect(screen.queryByTestId("player")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("link", { name: "标记" }));
    expect(await screen.findByTestId("player")).toBeInTheDocument();
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
