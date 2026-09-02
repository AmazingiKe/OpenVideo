import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlayerHandle } from "./Player";
import {
  PlaybackSessionProvider,
  use_playback_session,
} from "./playback_session";

let selected_asset_id: string | null = "asset-a";

vi.mock("@/app/asset_catalog", () => ({
  use_asset_catalog: () => ({ selected_asset_id }),
}));

afterEach(() => {
  selected_asset_id = "asset-a";
  vi.restoreAllMocks();
});

describe("PlaybackSessionProvider", () => {
  it("routes workspace commands through one attached player", async () => {
    const player = player_handle();
    let session: ReturnType<typeof use_playback_session> | null = null;
    const result = render(
      <PlaybackSessionProvider>
        <SessionProbe on_change={(value) => (session = value)} />
      </PlaybackSessionProvider>,
    );
    await waitFor(() => expect(session).not.toBeNull());

    act(() => session!.attach_player(player));
    act(() => {
      session!.preview_to(8.125);
      session!.seek_to(8.125);
      session!.set_playback_rate(1.5);
      session!.set_volume(0.4);
      session!.toggle_captions();
    });

    expect(player.preview_to).toHaveBeenCalledWith(8.125);
    expect(player.seek_to).toHaveBeenCalledWith(8.125);
    expect(player.set_playback_rate).toHaveBeenCalledWith(1.5);
    expect(player.set_volume).toHaveBeenCalledWith(0.4);
    expect(player.toggle_captions).toHaveBeenCalledOnce();
    expect(session!.player_ready).toBe(true);
    expect(session!.current_time).toBe(0);
    expect(session!.current_scrub_time).toBe(8.125);

    act(() => session!.report_time(8.125));
    expect(session!.current_time).toBe(8.125);
    expect(session!.current_scrub_time).toBeNull();

    fire_frame_key(".");
    fire_frame_key(",");
    expect(player.step_frame).toHaveBeenNthCalledWith(1, "next");
    expect(player.step_frame).toHaveBeenNthCalledWith(2, "previous");

    selected_asset_id = "asset-b";
    result.rerender(
      <PlaybackSessionProvider>
        <SessionProbe on_change={(value) => (session = value)} />
      </PlaybackSessionProvider>,
    );
    await waitFor(() => expect(session!.asset_id).toBe("asset-b"));
    expect(session!.current_time).toBe(0);
    expect(session!.current_scrub_time).toBeNull();
    expect(session!.paused).toBe(true);
  });

  it("does not capture frame shortcuts while editing text", async () => {
    const player = player_handle();
    let session: ReturnType<typeof use_playback_session> | null = null;
    const { container } = render(
      <PlaybackSessionProvider>
        <SessionProbe on_change={(value) => (session = value)} />
        <input aria-label="笔记正文" />
      </PlaybackSessionProvider>,
    );
    await waitFor(() => expect(session).not.toBeNull());
    act(() => session!.attach_player(player));

    const input = container.querySelector("input")!;
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: ".", bubbles: true }),
    );
    expect(player.step_frame).not.toHaveBeenCalled();
  });
});

function SessionProbe({
  on_change,
}: {
  on_change: (session: ReturnType<typeof use_playback_session>) => void;
}) {
  const session = use_playback_session();
  useEffect(() => {
    on_change(session);
  }, [on_change, session]);
  return null;
}

function player_handle(): PlayerHandle {
  return {
    seek_to: vi.fn(),
    preview_to: vi.fn(),
    current_time: vi.fn(() => 0),
    play: vi.fn(),
    pause: vi.fn(),
    toggle_playback: vi.fn(),
    set_playback_rate: vi.fn(),
    set_volume: vi.fn(),
    toggle_captions: vi.fn(),
    step_frame: vi.fn(),
  };
}

function fire_frame_key(key: "," | ".") {
  window.dispatchEvent(new KeyboardEvent("keydown", { key }));
}
