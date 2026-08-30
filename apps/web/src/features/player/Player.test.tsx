import { act, createRef, type PropsWithChildren } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Player, type PlayerHandle } from "./Player";

const media = vi.hoisted(() => ({
  player: {
    currentTime: 12,
    paused: true,
  },
  remote: {
    seek: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    changePlaybackRate: vi.fn(),
  },
  store: {
    currentTime: 12,
    paused: true,
    playbackRate: 1,
  },
}));

vi.mock("@vidstack/react", () => ({
  MediaPlayer: ({
    children,
    ariaLabel,
  }: PropsWithChildren<{ ariaLabel: string }>) => (
    <section aria-label={ariaLabel}>{children}</section>
  ),
  MediaProvider: () => <div data-testid="media-provider" />,
  useMediaPlayer: () => media.player,
  useMediaRemote: () => media.remote,
  useMediaStore: () => media.store,
}));

vi.mock("@vidstack/react/player/layouts/plyr", () => ({
  PlyrLayout: ({ controls }: { controls: string[] }) => (
    <div data-testid="plyr-layout" data-controls={controls.join(",")} />
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
});

describe("Player", () => {
  it("renders the complete bottom controls without the hidden large play button", () => {
    render(<Player src="/video.mp4" />);

    expect(screen.getByLabelText("OpenVideo 播放器")).toBeInTheDocument();
    expect(screen.getByTestId("media-provider")).toBeInTheDocument();
    expect(screen.getByTestId("plyr-layout")).toHaveAttribute(
      "data-controls",
      "play,progress,current-time,mute+volume,captions,settings,pip,airplay,fullscreen",
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
    expect(on_time_change).toHaveBeenCalledWith(8);

    act(() => player_ref.current?.toggle_playback());
    expect(media.remote.play).toHaveBeenCalledOnce();
    media.player.paused = false;
    act(() => player_ref.current?.toggle_playback());
    expect(media.remote.pause).toHaveBeenCalledOnce();

    act(() => player_ref.current?.set_playback_rate(1.5));
    expect(media.remote.changePlaybackRate).toHaveBeenCalledWith(1.5);
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
});
