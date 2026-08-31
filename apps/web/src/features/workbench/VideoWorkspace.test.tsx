import { createRef, forwardRef } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VideoWorkspace } from "./VideoWorkspace";
import type { PlayerHandle } from "../player/Player";
import type { MediaAsset, Transcript } from "../../shared/types";

const player_render = vi.hoisted(() => vi.fn());
const media_api = vi.hoisted(() => ({
  create_subtitle_export: vi.fn(),
  update_subtitle_settings: vi.fn(),
}));
const query_cache = vi.hoisted(() => ({ setQueryData: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => query_cache,
}));

vi.mock("@/shared/api", () => ({
  create_subtitle_export: media_api.create_subtitle_export,
  media_url: (path: string) => path,
  update_subtitle_settings: media_api.update_subtitle_settings,
}));

vi.mock("../player/Player", () => ({
  Player: forwardRef(function Player(props) {
    player_render(props);
    return <div data-testid="player" />;
  }),
}));

const ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f";

describe("VideoWorkspace", () => {
  beforeEach(() => {
    player_render.mockClear();
    query_cache.setQueryData.mockClear();
    media_api.update_subtitle_settings.mockImplementation(
      (_asset_id, settings) => Promise.resolve(settings),
    );
    media_api.create_subtitle_export.mockResolvedValue({
      export_id: "export-0198d12345677890abcdef1234567890",
      relative_path: `assets/${ASSET_ID}/artifacts/subtitle-exports/video.mp4`,
      file_name: "video.mp4",
      size_bytes: 100,
      exported_at: "2026-01-01T00:00:00Z",
    });
  });

  it("uses the player as the only playback control surface", () => {
    const player_ref = createRef<PlayerHandle>();
    player_ref.current = {
      current_time: () => 20,
      seek_to: vi.fn(),
      preview_to: vi.fn(),
      toggle_playback: vi.fn(),
      set_playback_rate: vi.fn(),
    };
    const workspace = render(
      <VideoWorkspace
        asset={create_asset()}
        transcript={null}
        markers={[]}
        player_ref={player_ref}
        on_time_change={vi.fn()}
        on_pause_change={vi.fn()}
        on_playback_rate_change={vi.fn()}
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
    expect(controls.queryByLabelText("播放控制")).not.toBeInTheDocument();
  });

  it("keeps the player tree stable across unrelated parent updates", () => {
    const props = {
      asset: create_asset(),
      transcript: null,
      markers: [],
      player_ref: createRef<PlayerHandle>(),
      on_time_change: vi.fn(),
      on_pause_change: vi.fn(),
      on_playback_rate_change: vi.fn(),
    };
    const workspace = render(<VideoWorkspace {...props} />);

    workspace.rerender(<VideoWorkspace {...props} />);

    expect(player_render).toHaveBeenCalledOnce();
  });

  it("saves subtitle display changes for the selected video", async () => {
    render(
      <VideoWorkspace
        asset={create_asset()}
        transcript={create_transcript()}
        markers={[]}
        player_ref={createRef<PlayerHandle>()}
        on_time_change={vi.fn()}
        on_pause_change={vi.fn()}
        on_playback_rate_change={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "字幕" }));
    fireEvent.click(screen.getByRole("radio", { name: "大" }));

    await waitFor(() =>
      expect(media_api.update_subtitle_settings).toHaveBeenCalledWith(
        ASSET_ID,
        {
          font_size: "large",
          position: "bottom",
          background: "shadow",
        },
      ),
    );
    expect(player_render.mock.lastCall?.[0]).toMatchObject({
      subtitle_display: { font_size: "large" },
    });
    expect(query_cache.setQueryData).toHaveBeenCalledOnce();
  });

  it("exports a separate video after settings are saved", async () => {
    render(
      <VideoWorkspace
        asset={create_asset()}
        transcript={create_transcript()}
        markers={[]}
        player_ref={createRef<PlayerHandle>()}
        on_time_change={vi.fn()}
        on_pause_change={vi.fn()}
        on_playback_rate_change={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "字幕" }));
    fireEvent.click(screen.getByRole("button", { name: "导出带字幕视频" }));

    await waitFor(() =>
      expect(media_api.create_subtitle_export).toHaveBeenCalledWith(ASSET_ID),
    );
    expect(
      await screen.findByText(/已保存：assets\/.*\/video\.mp4/),
    ).toBeInTheDocument();
  });
});

function create_transcript(): Transcript {
  return {
    asset_id: ASSET_ID,
    language: "zh",
    segments: [
      {
        start_seconds: 0,
        end_seconds: 2,
        text: "测试字幕",
        emotion: null,
        audio_events: [],
      },
    ],
    created_at: "2026-01-01T00:00:00Z",
  };
}

function create_asset(): MediaAsset {
  return {
    asset_id: ASSET_ID,
    folder_id: null,
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
    scrub_preview_url: "/scrub-preview",
    thumbnail_url: null,
    thumbnail_storyboard: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}
