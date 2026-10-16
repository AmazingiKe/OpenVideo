import { createRef, forwardRef } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayerHandle } from "@/features/player/Player";
import type { MediaAsset } from "@/shared/types";
import {
  download_subtitle_file,
  get_asset_playback,
  update_asset_playback,
} from "@/shared/api";
import { VideoWorkspace } from "./VideoWorkspace";

const player_render = vi.hoisted(() => vi.fn());
const query_client = vi.hoisted(() => ({
  setQueryData: vi.fn(),
  getQueryData: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => query_client,
}));

vi.mock("@/shared/api", () => ({
  create_subtitle_export: vi.fn(),
  download_subtitle_file: vi.fn(),
  get_asset_playback: vi.fn(),
  update_asset_playback: vi.fn(),
  ensure_thumbnail_storyboard: vi.fn(() => new Promise(() => undefined)),
  media_url: (path: string) => path,
  update_subtitle_settings: vi.fn(),
}));

vi.mock("@/features/player/Player", () => ({
  Player: forwardRef(function Player(props, ref) {
    player_render(props, ref);
    return <div data-testid="marker-player" />;
  }),
}));

describe("VideoWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(download_subtitle_file).mockResolvedValue();
    vi.mocked(get_asset_playback).mockImplementation(
      () => new Promise(() => undefined),
    );
  });

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
    const initial_render_count = player_render.mock.calls.length;

    workspace.rerender(<VideoWorkspace {...props} />);

    expect(player_render).toHaveBeenCalledTimes(initial_render_count);
  });

  it("stops chapter generation and disables repeated stop requests while the worker exits", () => {
    const on_cancel_chapters = vi.fn();
    const props = {
      ...create_workspace_props(),
      on_generate_chapters: vi.fn(),
      on_cancel_chapters,
      chapter_generation_message: "正在核对章节",
    };
    const { rerender } = render(<VideoWorkspace {...props} />);
    expect(screen.getByRole("button", { name: "生成中…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "停止生成" }));
    expect(on_cancel_chapters).toHaveBeenCalledOnce();
    rerender(<VideoWorkspace {...props} is_cancelling_chapters />);
    expect(screen.getByRole("button", { name: "正在停止…" })).toBeDisabled();
  });

  it("connects saved playback to the marker player and flushes a played pause", async () => {
    const progress = {
      library_id: "library-watch",
      position_seconds: 24,
      playback_rate: 1.5,
      last_watched_at: "2026-10-17T00:00:00Z",
    };
    vi.mocked(get_asset_playback).mockResolvedValue(progress);
    vi.mocked(update_asset_playback).mockResolvedValue(progress);
    render(<VideoWorkspace {...create_workspace_props()} />);
    await waitFor(() =>
      expect(player_render.mock.lastCall?.[0].initial_playback).toEqual(
        progress,
      ),
    );
    expect(player_render.mock.lastCall?.[0].duration_seconds).toBe(60);
    await act(async () =>
      player_render.mock.lastCall?.[0].on_progress_change(
        { ...progress, position_seconds: 30 },
        true,
      ),
    );
    expect(update_asset_playback).toHaveBeenCalledWith(
      create_asset().asset_id,
      {
        library_id: "library-watch",
        position_seconds: 30,
        playback_rate: 1.5,
        observed_at: expect.any(String),
      },
      false,
    );
  });

  it("downloads the selected subtitle file and confirms the browser download started", async () => {
    render(<VideoWorkspace {...create_workspace_props()} />);
    fireEvent.click(screen.getByRole("button", { name: "字幕" }));
    fireEvent.click(screen.getByRole("radio", { name: "TXT" }));
    fireEvent.click(screen.getByRole("button", { name: "下载字幕文件" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "已开始下载 TXT 字幕",
      ),
    );
    expect(download_subtitle_file).toHaveBeenCalledWith(
      create_asset().asset_id,
      "txt",
      expect.any(AbortSignal),
    );
    expect(screen.getByTestId("marker-player")).toBeInTheDocument();
  });

  it("shows server download errors and allows retrying", async () => {
    vi.mocked(download_subtitle_file).mockRejectedValueOnce(
      new Error("字幕尚未生成"),
    );
    render(<VideoWorkspace {...create_workspace_props()} />);
    fireEvent.click(screen.getByRole("button", { name: "字幕" }));
    fireEvent.click(screen.getByRole("button", { name: "下载字幕文件" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("字幕尚未生成"),
    );
    fireEvent.click(screen.getByRole("button", { name: "下载字幕文件" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "已开始下载 SRT 字幕",
      ),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a file download and its status when the same video's metadata refreshes", async () => {
    let finish_request: () => void = () => undefined;
    vi.mocked(download_subtitle_file).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish_request = resolve;
        }),
    );
    const props = create_workspace_props();
    const workspace = render(<VideoWorkspace {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "字幕" }));
    fireEvent.click(screen.getByRole("button", { name: "下载字幕文件" }));
    const signal = vi.mocked(download_subtitle_file).mock.calls[0][2];
    const refreshed_asset = {
      ...props.asset,
      title: "刷新后的视频标题",
      subtitle_display: { ...props.asset.subtitle_display! },
      updated_at: "2026-10-17T01:00:00Z",
    };
    workspace.rerender(<VideoWorkspace {...props} asset={refreshed_asset} />);
    expect(signal?.aborted).toBe(false);
    expect(screen.getByRole("button", { name: "正在下载字幕" })).toBeDisabled();
    await act(async () => finish_request());
    workspace.rerender(
      <VideoWorkspace
        {...props}
        asset={{ ...refreshed_asset, title: "再次刷新" }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("已开始下载 SRT 字幕");
  });

  it.each([true, false])(
    "ignores an old video download after switching assets (success: %s)",
    async (succeeds) => {
      let finish_old_request: () => void = () => undefined;
      let finish_new_request: () => void = () => undefined;
      vi.mocked(download_subtitle_file)
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve, reject) => {
              finish_old_request = () =>
                succeeds ? resolve() : reject(new Error("旧视频下载失败"));
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finish_new_request = resolve;
            }),
        );
      const props = create_workspace_props();
      const workspace = render(<VideoWorkspace {...props} />);
      fireEvent.click(screen.getByRole("button", { name: "字幕" }));
      fireEvent.click(screen.getByRole("button", { name: "下载字幕文件" }));
      const old_signal = vi.mocked(download_subtitle_file).mock.calls[0][2];

      workspace.rerender(
        <VideoWorkspace
          {...props}
          asset={{
            ...props.asset,
            asset_id: "asset-next",
            title: "第二个视频",
          }}
        />,
      );
      expect(old_signal?.aborted).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "下载字幕文件" }));
      await act(async () => finish_old_request());
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "正在下载字幕" }),
      ).toBeDisabled();
      await act(async () => finish_new_request());
      expect(screen.getByRole("status")).toHaveTextContent(
        "已开始下载 SRT 字幕",
      );
    },
  );
});

function create_workspace_props() {
  const asset = create_asset();
  return {
    asset,
    markers: [],
    transcript: {
      asset_id: asset.asset_id,
      language: "zh",
      created_at: asset.created_at,
      segments: [
        {
          start_seconds: 0,
          end_seconds: 10,
          text: "课程字幕",
          emotion: null,
          audio_events: [],
        },
      ],
    },
    player_ref: createRef<PlayerHandle>(),
    on_time_change: vi.fn(),
    on_pause_change: vi.fn(),
    on_playback_rate_change: vi.fn(),
  };
}

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
