import { act, createRef, type PropsWithChildren } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Player, type PlayerHandle } from "./Player";

const media = vi.hoisted(() => ({
  player: {
    currentTime: 12,
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
    currentTime: 12,
    paused: true,
    playbackRate: 1,
    volume: 1,
  },
  events: {
    seeking_request: null as ((seconds: number) => void) | null,
    seek_request: null as ((seconds: number) => void) | null,
    seeked: null as (() => void) | null,
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
  }: PropsWithChildren<{
    ariaLabel: string;
    "data-scrubbing"?: true;
    onMediaSeekingRequest?: (seconds: number) => void;
    onMediaSeekRequest?: (seconds: number) => void;
    onSeeked?: () => void;
  }>) => {
    media.events.seeking_request = onMediaSeekingRequest ?? null;
    media.events.seek_request = onMediaSeekRequest ?? null;
    media.events.seeked = onSeeked ?? null;
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
  media.store.paused = true;
  media.store.playbackRate = 1;
  media.store.volume = 1;
  media.events.seeking_request = null;
  media.events.seek_request = null;
  media.events.seeked = null;
});

describe("Player", () => {
  it("renders the complete bottom controls without the hidden large play button", () => {
    render(
      <Player
        src="/video.mp4"
        thumbnails={{
          url: "/thumbnails.jpg",
          tile_width: 640,
          tile_height: 360,
          tiles: [{ start_time: 0, x: 0, y: 0 }],
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
    expect(on_time_change).not.toHaveBeenCalled();

    act(() => player_ref.current?.toggle_playback());
    expect(media.remote.play).toHaveBeenCalledOnce();
    media.player.paused = false;
    act(() => player_ref.current?.toggle_playback());
    expect(media.remote.pause).toHaveBeenCalledOnce();

    act(() => player_ref.current?.set_playback_rate(1.5));
    expect(media.remote.changePlaybackRate).toHaveBeenCalledWith(1.5);
  });

  it("keeps the presented media clock unchanged until a scrub commits", () => {
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

    expect(player_ref.current?.current_time()).toBe(12);
    expect(media.player.currentTime).toBe(12);
    expect(media.remote.seek).not.toHaveBeenCalled();
    expect(on_time_change).not.toHaveBeenCalled();

    media.store.currentTime = 13;
    rerender(
      <Player
        ref={player_ref}
        src="/video.mp4"
        on_time_change={on_time_change}
      />,
    );
    expect(player_ref.current?.current_time()).toBe(12);
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
    expect(player_ref.current?.current_time()).toBe(12);
    expect(media.remote.seek).not.toHaveBeenCalled();
    expect(on_time_change).not.toHaveBeenCalled();

    act(() => media.events.seek_request?.(16));
    expect(on_time_change).not.toHaveBeenCalled();
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
