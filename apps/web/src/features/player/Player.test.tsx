import {
  act,
  createRef,
  useEffect,
  useRef,
  type PropsWithChildren,
} from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Player, type PlayerHandle } from "./Player";
import { WorkspaceActiveContext } from "@/app/workspace_activity";
import { use_playback_progress } from "./use_playback_progress";
import { get_asset_playback } from "@/shared/api";
import type { PlaybackState } from "@/shared/types";

vi.mock("@/shared/api", () => ({
  get_asset_playback: vi.fn(),
  update_asset_playback: vi.fn(),
}));

const media = vi.hoisted(() => ({
  player: {
    pause: vi.fn(),
    currentTime: 12,
    duration: 60,
    paused: true,
    controls: {
      pause: vi.fn(),
      resume: vi.fn(),
    },
  },
  remote: {
    seek: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    changePlaybackRate: vi.fn(),
    changeVolume: vi.fn(),
    toggleCaptions: vi.fn(),
  },
  store: {
    canPlay: true,
    currentTime: 12,
    paused: true,
    playbackRate: 1,
    volume: 1,
  },
  events: {
    seeking_request: null as ((seconds: number) => void) | null,
    seek_request: null as ((seconds: number) => void) | null,
    seeked: null as (() => void) | null,
    playing: null as (() => void) | null,
    ended: null as (() => void) | null,
    playback_rate: undefined as number | undefined,
  },
}));

vi.mock("@vidstack/react", () => ({
  MediaPlayer: ({
    children,
    ariaLabel,
    "data-scrubbing": is_scrubbing,
    onMediaSeekingRequest,
    onMediaSeekRequest,
    onSeeked,
    onPlaying,
    onEnded,
    playbackRate,
  }: PropsWithChildren<{
    ariaLabel: string;
    "data-scrubbing"?: true;
    onMediaSeekingRequest?: (seconds: number) => void;
    onMediaSeekRequest?: (seconds: number) => void;
    onSeeked?: () => void;
    onPlaying?: () => void;
    onEnded?: () => void;
    playbackRate?: number;
  }>) => {
    media.events.seeking_request = onMediaSeekingRequest ?? null;
    media.events.seek_request = onMediaSeekRequest ?? null;
    media.events.seeked = onSeeked ?? null;
    media.events.playing = onPlaying ?? null;
    media.events.ended = onEnded ?? null;
    media.events.playback_rate = playbackRate;
    return (
      <section
        aria-label={ariaLabel}
        data-scrubbing={is_scrubbing || undefined}
      >
        {children}
      </section>
    );
  },
  MediaProvider: () => <div data-testid="media-provider" />,
  useMediaPlayer: () => media.player,
  useMediaProvider: () => null,
  useMediaRemote: () => media.remote,
  useMediaStore: () => media.store,
  isVideoProvider: () => false,
}));

vi.mock("@vidstack/react/player/layouts/plyr", () => ({
  PlyrLayout: ({
    controls,
    invertTime,
    thumbnails,
  }: {
    controls: string[];
    invertTime: boolean;
    thumbnails?: unknown;
  }) => (
    <div
      data-testid="plyr-layout"
      data-controls={controls.join(",")}
      data-invert-time={String(invertTime)}
      data-thumbnails={String(thumbnails !== undefined)}
    >
      <div role="slider" aria-label="播放进度" data-media-time-slider />
    </div>
  ),
  plyrLayoutIcons: {},
}));

beforeEach(() => {
  vi.clearAllMocks();
  media.player.currentTime = 12;
  media.player.paused = true;
  media.store.currentTime = 12;
  media.store.canPlay = true;
  media.store.paused = true;
  media.store.playbackRate = 1;
  media.store.volume = 1;
  media.events.seeking_request = null;
  media.events.seek_request = null;
  media.events.seeked = null;
  media.events.playing = null;
  media.events.ended = null;
});

describe("Player", () => {
  it("keeps a parent evidence seek after reactivation while the progress GET is delayed", async () => {
    let finish_read: (state: PlaybackState) => void = () => undefined;
    vi.mocked(get_asset_playback).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish_read = resolve;
        }),
    );
    function EvidenceWorkspace({ active }: { active: boolean }) {
      const playback = use_playback_progress(
        "asset-evidence-reactivation",
        active,
      );
      const player_ref = useRef<PlayerHandle>(null);
      useEffect(() => {
        if (active) player_ref.current?.seek_to(8);
      }, [active]);
      return (
        <WorkspaceActiveContext.Provider value={active}>
          <Player
            ref={player_ref}
            src="/evidence.mp4"
            initial_playback={playback.initial_playback}
            playback_restore_key={playback.playback_restore_key}
            on_progress_change={playback.on_progress_change}
          />
        </WorkspaceActiveContext.Provider>
      );
    }
    const query_client = new QueryClient();
    const workspace = render(
      <QueryClientProvider client={query_client}>
        <EvidenceWorkspace active={false} />
      </QueryClientProvider>,
    );
    await act(async () => undefined);
    workspace.rerender(
      <QueryClientProvider client={query_client}>
        <EvidenceWorkspace active />
      </QueryClientProvider>,
    );
    await act(async () => undefined);
    expect(media.remote.seek).toHaveBeenCalledExactlyOnceWith(8);
    await act(async () =>
      finish_read({
        library_id: "library-watch",
        position_seconds: 32,
        playback_rate: 2,
        last_watched_at: null,
      }),
    );
    expect(media.remote.seek).toHaveBeenCalledExactlyOnceWith(8);
  });

  it("flushes the exact duration at natural completion rather than the last video frame", () => {
    media.store.currentTime = 59.96;
    const on_progress_change = vi.fn();
    const player = render(
      <Player
        src="/ending.mp4"
        duration_seconds={60}
        on_progress_change={on_progress_change}
      />,
    );
    act(() => media.events.playing?.());
    act(() => media.events.ended?.());
    expect(on_progress_change).toHaveBeenLastCalledWith(
      { position_seconds: 60, playback_rate: 1, last_watched_at: null },
      true,
    );
    media.store.currentTime = 59.98;
    player.rerender(
      <Player
        src="/ending.mp4"
        duration_seconds={60}
        on_progress_change={on_progress_change}
      />,
    );
    expect(on_progress_change).toHaveBeenLastCalledWith(
      { position_seconds: 60, playback_rate: 1, last_watched_at: null },
      true,
    );
  });

  it("preserves an evidence seek while the first playback session is being initialized", () => {
    media.store.canPlay = false;
    const player_ref = createRef<PlayerHandle>();
    const player = render(
      <Player ref={player_ref} src="/evidence.mp4" playback_restore_key={0} />,
    );
    act(() => player_ref.current?.seek_to(8));
    media.store.canPlay = true;
    player.rerender(
      <Player
        ref={player_ref}
        src="/evidence.mp4"
        playback_restore_key={1}
        initial_playback={{
          position_seconds: 32,
          playback_rate: 2,
          last_watched_at: null,
        }}
      />,
    );
    expect(media.remote.seek).toHaveBeenCalledExactlyOnceWith(8);
  });

  it("restores time and playback rate once while remaining paused", () => {
    const initial_playback = {
      position_seconds: 32,
      playback_rate: 2,
      last_watched_at: "2026-10-17T00:00:00Z",
    };
    const player = render(
      <Player
        src="/video.mp4"
        initial_playback={initial_playback}
        duration_seconds={60}
      />,
    );
    expect(media.remote.seek).toHaveBeenCalledExactlyOnceWith(32);
    expect(media.events.playback_rate).toBe(2);
    expect(media.remote.play).not.toHaveBeenCalled();
    player.rerender(
      <Player
        src="/video.mp4"
        initial_playback={{ ...initial_playback, position_seconds: 50 }}
        duration_seconds={60}
      />,
    );
    expect(media.remote.seek).toHaveBeenCalledTimes(1);
  });

  it("opens a fully watched video at the start without automatically playing", () => {
    render(
      <Player
        src="/complete.mp4"
        duration_seconds={60}
        initial_playback={{
          position_seconds: 60,
          playback_rate: 1.5,
          last_watched_at: "2026-10-17T00:00:00Z",
        }}
      />,
    );
    expect(media.remote.seek).toHaveBeenCalledExactlyOnceWith(0);
    expect(media.remote.play).not.toHaveBeenCalled();
  });

  it("keeps an explicit evidence seek queued before media readiness and gives it priority", () => {
    media.store.canPlay = false;
    const player_ref = createRef<PlayerHandle>();
    const initial_playback = {
      position_seconds: 32,
      playback_rate: 2,
      last_watched_at: null,
    };
    const player = render(
      <Player
        ref={player_ref}
        src="/evidence.mp4"
        initial_playback={initial_playback}
      />,
    );
    act(() => player_ref.current?.seek_to(8));
    expect(media.remote.seek).not.toHaveBeenCalled();
    media.store.canPlay = true;
    player.rerender(
      <Player
        ref={player_ref}
        src="/evidence.mp4"
        initial_playback={initial_playback}
      />,
    );
    expect(media.remote.seek).toHaveBeenCalledExactlyOnceWith(8);
  });

  it("does not apply a late resume snapshot after the user has already played", () => {
    const player = render(<Player src="/video.mp4" />);
    act(() => media.events.playing?.());
    player.rerender(
      <Player
        src="/video.mp4"
        initial_playback={{
          position_seconds: 32,
          playback_rate: 2,
          last_watched_at: null,
        }}
      />,
    );
    expect(media.remote.seek).not.toHaveBeenCalled();
  });

  it("reports confirmed played progress while excluding drag previews and initial paused state", () => {
    const player_ref = createRef<PlayerHandle>();
    const on_progress_change = vi.fn();
    render(
      <Player
        ref={player_ref}
        src="/video.mp4"
        on_progress_change={on_progress_change}
      />,
    );
    expect(on_progress_change).not.toHaveBeenCalled();
    act(() => media.events.playing?.());
    expect(on_progress_change).toHaveBeenLastCalledWith(
      { position_seconds: 12, playback_rate: 1, last_watched_at: null },
      false,
    );
    on_progress_change.mockClear();
    act(() => player_ref.current?.begin_scrub(40));
    act(() => player_ref.current?.update_scrub(45));
    expect(on_progress_change).not.toHaveBeenCalled();
    act(() => player_ref.current?.commit_scrub(45));
    expect(on_progress_change).not.toHaveBeenCalled();
    media.player.currentTime = 45;
    act(() => media.events.seeked?.());
    expect(on_progress_change).toHaveBeenCalledExactlyOnceWith(
      { position_seconds: 45, playback_rate: 1, last_watched_at: null },
      true,
    );
  });

  it("publishes native progress previews immediately and restores the clock on cancellation", () => {
    const player_ref = createRef<PlayerHandle>();
    const on_time_change = vi.fn();
    render(
      <Player
        ref={player_ref}
        src="/video.mp4"
        on_time_change={on_time_change}
      />,
    );
    on_time_change.mockClear();
    act(() => media.events.seeking_request?.(18.125));
    expect(on_time_change).toHaveBeenLastCalledWith(18.125);
    expect(player_ref.current?.current_time()).toBe(18.125);
    act(() => media.events.seeking_request?.(28.625));
    expect(on_time_change).toHaveBeenLastCalledWith(28.625);
    expect(player_ref.current?.current_time()).toBe(28.625);
    expect(media.remote.seek).not.toHaveBeenCalled();
    expect(media.player.currentTime).toBe(12);
    act(() => player_ref.current?.cancel_scrub());
    expect(on_time_change).toHaveBeenLastCalledWith(12);
    expect(player_ref.current?.current_time()).toBe(12);
  });

  it("ignores an older seek confirmation after a new drag has started", () => {
    const player_ref = createRef<PlayerHandle>();
    const on_time_change = vi.fn();
    render(
      <Player
        ref={player_ref}
        src="/video.mp4"
        on_time_change={on_time_change}
      />,
    );
    act(() => media.events.seeking_request?.(16));
    act(() => media.events.seek_request?.(16));
    act(() => media.events.seeking_request?.(20));
    on_time_change.mockClear();
    media.player.currentTime = 16;
    act(() => media.events.seeked?.());
    expect(player_ref.current?.current_time()).toBe(20);
    expect(on_time_change).not.toHaveBeenCalled();
    expect(screen.getByLabelText("OpenVideo 播放器")).toHaveAttribute(
      "data-scrubbing",
    );
  });
  it("pauses on workspace exit without replacing the player or resuming on return", () => {
    const player_ref = createRef<PlayerHandle>();
    const { rerender } = render(
      <WorkspaceActiveContext.Provider value={true}>
        <Player ref={player_ref} src="/video.mp4" />
      </WorkspaceActiveContext.Provider>,
    );
    const provider = screen.getByTestId("media-provider");
    media.store.paused = false;
    act(() => player_ref.current?.begin_scrub(30));
    rerender(
      <WorkspaceActiveContext.Provider value={false}>
        <Player ref={player_ref} src="/video.mp4" />
      </WorkspaceActiveContext.Provider>,
    );
    expect(media.remote.pause).toHaveBeenCalled();
    expect(media.player.pause).toHaveBeenCalled();
    rerender(
      <WorkspaceActiveContext.Provider value={true}>
        <Player ref={player_ref} src="/video.mp4" />
      </WorkspaceActiveContext.Provider>,
    );
    expect(screen.getByTestId("media-provider")).toBe(provider);
    expect(media.remote.play).not.toHaveBeenCalled();
  });
  it("renders the complete bottom controls without the hidden large play button", () => {
    render(
      <Player
        src="/video.mp4"
        storyboard={{
          storyboard_id: "storyboard-test",
          tile_width: 640,
          tile_height: 360,
          interval_seconds: 5,
          columns: 5,
          total_tiles: 1,
          pages: [
            { url: "/storyboard-page.jpg", start_index: 0, tile_count: 1 },
          ],
        }}
      />,
    );

    expect(screen.getByLabelText("OpenVideo 播放器")).toBeInTheDocument();
    expect(screen.getByTestId("media-provider")).toBeInTheDocument();
    expect(screen.getByTestId("plyr-layout")).toHaveAttribute(
      "data-controls",
      "play,progress,current-time,mute+volume,settings,pip,airplay,fullscreen",
    );
    expect(screen.getByTestId("plyr-layout")).toHaveAttribute(
      "data-invert-time",
      "false",
    );
    expect(screen.getByTestId("plyr-layout")).toHaveAttribute(
      "data-thumbnails",
      "false",
    );
    expect(
      screen.queryByRole("group", { name: "精确定位" }),
    ).not.toBeInTheDocument();
  });

  it("exposes playback commands through the stable player handle", () => {
    const player_ref = createRef<PlayerHandle>();
    const on_time_change = vi.fn();
    render(
      <Player
        ref={player_ref}
        src="/video.mp4"
        on_time_change={on_time_change}
      />,
    );
    on_time_change.mockClear();

    expect(player_ref.current?.current_time()).toBe(12);
    act(() => player_ref.current?.seek_to(8));
    expect(media.remote.seek).toHaveBeenCalledWith(8);
    expect(on_time_change).toHaveBeenLastCalledWith(8);

    act(() => player_ref.current?.toggle_playback());
    expect(media.remote.play).toHaveBeenCalledOnce();
    media.player.paused = false;
    act(() => player_ref.current?.toggle_playback());
    expect(media.remote.pause).toHaveBeenCalledOnce();
  });

  it("reports the scrub clock while ignoring stale presented times", () => {
    const player_ref = createRef<PlayerHandle>();
    const on_time_change = vi.fn();
    const { rerender } = render(
      <Player
        ref={player_ref}
        src="/video.mp4"
        on_time_change={on_time_change}
      />,
    );
    on_time_change.mockClear();

    act(() => player_ref.current?.begin_scrub(16));
    act(() => player_ref.current?.update_scrub(16));

    expect(player_ref.current?.current_time()).toBe(16);
    expect(media.player.currentTime).toBe(12);
    expect(media.remote.seek).not.toHaveBeenCalled();
    expect(on_time_change).toHaveBeenLastCalledWith(16);
    on_time_change.mockClear();

    media.store.currentTime = 13;
    rerender(
      <Player
        ref={player_ref}
        src="/video.mp4"
        on_time_change={on_time_change}
      />,
    );
    expect(player_ref.current?.current_time()).toBe(16);
    expect(on_time_change).not.toHaveBeenCalled();
  });

  it("keeps controls visible until the native progress drag presents its frame", () => {
    const player_ref = createRef<PlayerHandle>();
    render(<Player ref={player_ref} src="/video.mp4" />);
    const player = screen.getByLabelText("OpenVideo 播放器");

    act(() => player_ref.current?.begin_scrub(16));
    expect(player).toHaveAttribute("data-scrubbing");
    expect(media.player.controls.pause).toHaveBeenCalledOnce();

    act(() => player_ref.current?.commit_scrub(16));
    expect(player).toHaveAttribute("data-scrubbing");

    media.player.currentTime = 16;
    act(() => media.events.seeked?.());
    expect(player).not.toHaveAttribute("data-scrubbing");
    expect(media.player.controls.resume).toHaveBeenCalledOnce();
  });

  it("holds control visibility from progress pointer down to pointer up", () => {
    render(<Player src="/video.mp4" />);
    const progress = screen.getByRole("slider", { name: "播放进度" });

    fireEvent.pointerDown(progress);
    expect(media.player.controls.pause).toHaveBeenCalledOnce();
    expect(media.player.controls.resume).not.toHaveBeenCalled();

    fireEvent.pointerUp(progress);
    expect(media.player.controls.resume).toHaveBeenCalledOnce();
  });

  it("releases control visibility when seek confirmation times out", () => {
    vi.useFakeTimers();
    try {
      const player_ref = createRef<PlayerHandle>();
      render(<Player ref={player_ref} src="/video.mp4" />);

      act(() => player_ref.current?.begin_scrub(16));
      act(() => player_ref.current?.commit_scrub(16));
      expect(media.player.controls.pause).toHaveBeenCalledOnce();

      act(() => vi.advanceTimersByTime(1_500));
      expect(media.player.controls.resume).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores stale time events while an external seek is pending", () => {
    const player_ref = createRef<PlayerHandle>();
    const on_time_change = vi.fn();
    const { rerender } = render(
      <Player
        ref={player_ref}
        src="/video.mp4"
        on_time_change={on_time_change}
      />,
    );
    act(() => player_ref.current?.seek_to(8));
    on_time_change.mockClear();

    media.store.currentTime = 3;
    rerender(
      <Player
        ref={player_ref}
        src="/video.mp4"
        on_time_change={on_time_change}
      />,
    );
    expect(on_time_change).not.toHaveBeenCalled();

    media.store.currentTime = 8.1;
    rerender(
      <Player
        ref={player_ref}
        src="/video.mp4"
        on_time_change={on_time_change}
      />,
    );
    expect(on_time_change).not.toHaveBeenCalled();
    media.player.currentTime = 8.1;
    act(() => media.events.seeked?.());
    expect(on_time_change).toHaveBeenCalledWith(8.1);
  });

  it("renders the active evidence subtitle", () => {
    render(
      <Player
        src="/video.mp4"
        subtitles={[
          {
            start_seconds: 10,
            end_seconds: 14,
            text: " 证据字幕 ",
            emotion: null,
            audio_events: [],
          },
        ]}
        evidence_range={{
          evidence_id: "evidence-0198d12345677890abcdef1234567890",
          start_seconds: 11,
          end_seconds: 13,
        }}
      />,
    );

    expect(screen.getByLabelText("视频字幕，答案证据")).toHaveTextContent(
      "证据字幕",
    );
  });

  it("applies the saved subtitle offset without changing media time", () => {
    const player_ref = createRef<PlayerHandle>();
    render(
      <Player
        ref={player_ref}
        src="/video.mp4"
        subtitles={[
          {
            start_seconds: 12.4,
            end_seconds: 13,
            text: "校准后的字幕",
            emotion: null,
            audio_events: [],
          },
        ]}
        subtitle_display={{
          font_size: "medium",
          position: "bottom",
          background: "shadow",
          offset_milliseconds: 500,
        }}
      />,
    );

    expect(screen.getByLabelText("视频字幕")).toHaveTextContent("校准后的字幕");
    expect(media.player.currentTime).toBe(12);

    act(() => player_ref.current?.toggle_captions());
    expect(screen.queryByLabelText("视频字幕")).not.toBeInTheDocument();
  });

  it("applies the saved subtitle display presets", () => {
    render(
      <Player
        src="/video.mp4"
        subtitles={[
          {
            start_seconds: 10,
            end_seconds: 14,
            text: "自定义字幕",
            emotion: null,
            audio_events: [],
          },
        ]}
        subtitle_display={{
          font_size: "large",
          position: "center",
          background: "solid",
          offset_milliseconds: 0,
        }}
      />,
    );

    expect(screen.getByLabelText("视频字幕")).toMatchObject({
      dataset: {
        fontSize: "large",
        position: "center",
        background: "solid",
      },
    });
  });

  it("updates the scrub clock while keeping the presented frame unchanged until release", () => {
    const player_ref = createRef<PlayerHandle>();
    const on_time_change = vi.fn();
    const subtitles = [
      {
        start_seconds: 10,
        end_seconds: 14,
        text: "当前字幕",
        emotion: null,
        audio_events: [],
      },
      {
        start_seconds: 15,
        end_seconds: 18,
        text: "跳转后字幕",
        emotion: null,
        audio_events: [],
      },
    ];
    const { rerender } = render(
      <Player
        ref={player_ref}
        src="/video.mp4"
        on_time_change={on_time_change}
        subtitles={subtitles}
      />,
    );

    expect(screen.getByLabelText("视频字幕")).toHaveTextContent("当前字幕");
    on_time_change.mockClear();
    act(() => media.events.seeking_request?.(16));

    expect(screen.getByLabelText("视频字幕")).toHaveTextContent("当前字幕");
    expect(media.player.currentTime).toBe(12);
    expect(player_ref.current?.current_time()).toBe(16);
    expect(media.remote.seek).not.toHaveBeenCalled();
    expect(on_time_change).toHaveBeenLastCalledWith(16);

    act(() => media.events.seek_request?.(16));
    expect(on_time_change).toHaveBeenLastCalledWith(16);
    expect(player_ref.current?.current_time()).toBe(16);
    media.player.currentTime = 16;
    media.store.currentTime = 16;
    act(() => media.events.seeked?.());
    expect(on_time_change).toHaveBeenCalledWith(16);
    rerender(
      <Player
        ref={player_ref}
        src="/video.mp4"
        on_time_change={on_time_change}
        subtitles={subtitles}
      />,
    );

    expect(screen.getByLabelText("视频字幕")).toHaveTextContent("跳转后字幕");
  });

  it("freezes playing video during scrub and resumes after the target frame appears", () => {
    media.player.paused = false;
    media.store.paused = false;
    render(<Player src="/video.mp4" />);

    act(() => media.events.seeking_request?.(18));
    expect(media.remote.pause).toHaveBeenCalledOnce();

    act(() => media.events.seek_request?.(18));
    media.player.currentTime = 18;
    act(() => media.events.seeked?.());
    expect(media.remote.play).toHaveBeenCalledOnce();
  });

  it("cancels a lost scrub gesture without seeking the video", () => {
    const player_ref = createRef<PlayerHandle>();
    media.player.paused = false;
    media.store.paused = false;
    render(<Player ref={player_ref} src="/video.mp4" />);

    act(() => player_ref.current?.begin_scrub(18));
    act(() => player_ref.current?.cancel_scrub());

    expect(media.remote.seek).not.toHaveBeenCalled();
    expect(player_ref.current?.current_time()).toBe(12);
    expect(media.remote.play).toHaveBeenCalledOnce();
  });
});
