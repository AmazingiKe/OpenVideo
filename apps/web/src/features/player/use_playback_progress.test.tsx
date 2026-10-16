import { act, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { get_asset_playback, update_asset_playback } from "@/shared/api";
import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import type { PlaybackProgress, PlaybackState } from "@/shared/types";
import { use_playback_progress } from "./use_playback_progress";

vi.mock("@/shared/api", () => ({
  get_asset_playback: vi.fn(),
  update_asset_playback: vi.fn(),
}));
const library_identity = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("@/app/library", () => ({
  use_library_identity: () => library_identity.value,
}));

const initial_state: PlaybackState = {
  library_id: "library-watch",
  position_seconds: 12,
  playback_rate: 1.5,
  last_watched_at: "2026-10-17T00:00:00Z",
};

beforeEach(() => {
  library_identity.value = null;
  vi.useFakeTimers();
  vi.mocked(get_asset_playback).mockReset().mockResolvedValue(initial_state);
  vi.mocked(update_asset_playback)
    .mockReset()
    .mockImplementation(async (_asset_id, progress) => ({
      ...progress,
      last_watched_at: "2026-10-17T01:00:00Z",
    }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("playback progress lifecycle", () => {
  it("sends pagehide keepalive immediately and skips older queued observations", async () => {
    let finish_first: (state: PlaybackState) => void = () => undefined;
    vi.mocked(update_asset_playback).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish_first = resolve;
        }),
    );
    const { wrapper } = create_query_wrapper();
    const hook = renderHook(
      () => use_playback_progress("asset-exit-inflight", true),
      { wrapper },
    );
    await act(async () => undefined);
    act(() => hook.result.current.on_progress_change(sample(20), true));
    act(() => hook.result.current.on_progress_change(sample(30), true));
    act(() => hook.result.current.on_progress_change(sample(40), false));
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(update_asset_playback).toHaveBeenCalledTimes(2);
    const first = vi.mocked(update_asset_playback).mock.calls[0][1];
    const final = vi.mocked(update_asset_playback).mock.calls[1];
    expect(final[1].position_seconds).toBe(40);
    expect(final[2]).toBe(true);
    expect(Date.parse(final[1].observed_at!)).toBeGreaterThan(
      Date.parse(first.observed_at!),
    );
    await act(async () => finish_first({ ...initial_state, ...first }));
    expect(update_asset_playback).toHaveBeenCalledTimes(2);
  });

  it("flushes a bound library before its initial GET finishes and hands that progress to the next workspace", async () => {
    library_identity.value = "library-watch";
    let finish_old_read: (state: PlaybackState) => void = () => undefined;
    let server_state = initial_state;
    vi.mocked(get_asset_playback)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish_old_read = resolve;
          }),
      )
      .mockImplementation(async () => server_state);
    vi.mocked(update_asset_playback).mockImplementation(
      async (_asset_id, progress) => {
        server_state = { ...initial_state, ...progress };
        return server_state;
      },
    );
    const { wrapper } = create_query_wrapper();
    const marking = renderHook(
      ({ active }) => use_playback_progress("asset-early-handoff", active),
      { wrapper, initialProps: { active: true } },
    );
    await act(async () => undefined);
    act(() => marking.result.current.on_progress_change(sample(37), false));
    marking.rerender({ active: false });
    const summary = renderHook(
      () => use_playback_progress("asset-early-handoff", true),
      { wrapper },
    );
    await act(async () => undefined);
    expect(summary.result.current.initial_playback?.position_seconds).toBe(37);
    expect(vi.mocked(get_asset_playback).mock.calls[0][1]?.aborted).toBe(true);
    await act(async () =>
      finish_old_read({ ...initial_state, library_id: "library-another" }),
    );
    expect(update_asset_playback).toHaveBeenCalledTimes(1);
    expect(summary.result.current.initial_playback?.position_seconds).toBe(37);
  });

  it("rejects a GET from a switched library and never uses its identity for saves", async () => {
    library_identity.value = "library-watch";
    vi.mocked(get_asset_playback).mockResolvedValue({
      ...initial_state,
      library_id: "library-another",
    });
    const { wrapper } = create_query_wrapper();
    const hook = renderHook(
      () => use_playback_progress("asset-wrong-library", true),
      { wrapper },
    );
    await act(async () => undefined);
    expect(hook.result.current.initial_playback).toBeNull();
    expect(hook.result.current.save_error).toContain("资料库已切换");
    act(() => hook.result.current.on_progress_change(sample(20), true));
    expect(update_asset_playback).not.toHaveBeenCalled();
  });

  it("restores a snapshot without saving when merely mounted or inactive", async () => {
    const { wrapper } = create_query_wrapper();
    const hook = renderHook(
      ({ active }) => use_playback_progress("asset-open", active),
      { wrapper, initialProps: { active: true } },
    );
    await act(async () => undefined);
    expect(hook.result.current.initial_playback).toEqual(initial_state);
    hook.rerender({ active: false });
    act(() => hook.result.current.on_progress_change(sample(0), true));
    await act(async () => vi.advanceTimersByTime(10_000));
    hook.unmount();
    expect(update_asset_playback).not.toHaveBeenCalled();
  });

  it("throttles played progress to five seconds and saves the latest time and rate", async () => {
    const { wrapper, query_client } = create_query_wrapper();
    const hook = renderHook(
      () => use_playback_progress("asset-throttle", true),
      { wrapper },
    );
    await act(async () => undefined);
    act(() => hook.result.current.on_progress_change(sample(20), false));
    await act(async () => vi.advanceTimersByTime(4_000));
    act(() => hook.result.current.on_progress_change(sample(24, 2), false));
    expect(update_asset_playback).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(update_asset_playback).toHaveBeenCalledExactlyOnceWith(
      "asset-throttle",
      {
        library_id: "library-watch",
        position_seconds: 24,
        playback_rate: 2,
        observed_at: expect.any(String),
      },
      false,
    );
    expect(
      query_client.getQueryData<PlaybackState>(
        RESOURCE_QUERY_KEYS.asset_playback("asset-throttle"),
      )?.position_seconds,
    ).toBe(24);
    expect(hook.result.current.initial_playback?.position_seconds).toBe(12);
  });

  it("serializes saves so a slow old request cannot overwrite a newer pause", async () => {
    let finish_first: (state: PlaybackState) => void = () => undefined;
    vi.mocked(update_asset_playback).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish_first = resolve;
        }),
    );
    const { wrapper, query_client } = create_query_wrapper();
    const hook = renderHook(() => use_playback_progress("asset-serial", true), {
      wrapper,
    });
    await act(async () => undefined);
    act(() => hook.result.current.on_progress_change(sample(20), true));
    act(() => hook.result.current.on_progress_change(sample(40), true));
    expect(update_asset_playback).toHaveBeenCalledTimes(1);
    await act(async () =>
      finish_first({ ...initial_state, position_seconds: 20 }),
    );
    expect(update_asset_playback).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(update_asset_playback).mock.calls[1][1].position_seconds,
    ).toBe(40);
    expect(
      query_client.getQueryData<PlaybackState>(
        RESOURCE_QUERY_KEYS.asset_playback("asset-serial"),
      )?.position_seconds,
    ).toBe(40);
  });

  it.each(["pagehide", "unmount"])(
    "flushes the latest played position using keepalive on %s",
    async (reason) => {
      const { wrapper } = create_query_wrapper();
      const hook = renderHook(
        () => use_playback_progress(`asset-${reason}`, true),
        { wrapper },
      );
      await act(async () => undefined);
      act(() => hook.result.current.on_progress_change(sample(29), false));
      if (reason === "pagehide")
        act(() => window.dispatchEvent(new Event("pagehide")));
      else hook.unmount();
      await act(async () => undefined);
      expect(update_asset_playback).toHaveBeenCalledExactlyOnceWith(
        `asset-${reason}`,
        {
          library_id: "library-watch",
          position_seconds: 29,
          playback_rate: 1.5,
          observed_at: expect.any(String),
        },
        true,
      );
    },
  );

  it("waits for the departing workspace to save before restoring the summary player", async () => {
    let server_state = initial_state;
    let finish_departing_save: () => void = () => undefined;
    vi.mocked(get_asset_playback).mockImplementation(async () => server_state);
    vi.mocked(update_asset_playback).mockImplementationOnce(
      async (_asset_id, progress) => {
        await new Promise<void>((resolve) => {
          finish_departing_save = resolve;
        });
        server_state = { ...initial_state, ...progress };
        return server_state;
      },
    );
    const { wrapper } = create_query_wrapper();
    const marking_player = renderHook(
      ({ active }) => use_playback_progress("asset-handoff", active),
      { wrapper, initialProps: { active: true } },
    );
    await act(async () => undefined);
    act(() =>
      marking_player.result.current.on_progress_change(sample(37, 2), false),
    );
    marking_player.rerender({ active: false });
    const summary_player = renderHook(
      () => use_playback_progress("asset-handoff", true),
      { wrapper },
    );
    await act(async () => undefined);
    expect(get_asset_playback).toHaveBeenCalledTimes(1);
    expect(summary_player.result.current.initial_playback).toBeNull();
    await act(async () => finish_departing_save());
    expect(
      summary_player.result.current.initial_playback?.position_seconds,
    ).toBe(37);
    expect(summary_player.result.current.initial_playback?.playback_rate).toBe(
      2,
    );
    act(() =>
      marking_player.result.current.on_progress_change(sample(0), true),
    );
    expect(update_asset_playback).toHaveBeenCalledTimes(1);
  });

  it("preserves new playback when the initial GET arrives after the user starts", async () => {
    let finish_read: (state: PlaybackState) => void = () => undefined;
    vi.mocked(get_asset_playback).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish_read = resolve;
        }),
    );
    const { wrapper } = create_query_wrapper();
    const hook = renderHook(
      () => use_playback_progress("asset-late-read", true),
      { wrapper },
    );
    await act(async () => undefined);
    act(() => hook.result.current.on_progress_change(sample(33), true));
    await act(async () => finish_read(initial_state));
    expect(hook.result.current.initial_playback).toBeNull();
    expect(
      vi.mocked(update_asset_playback).mock.calls[0][1].position_seconds,
    ).toBe(33);
  });
});

function sample(
  position_seconds: number,
  playback_rate = 1.5,
): PlaybackProgress {
  return { position_seconds, playback_rate, last_watched_at: null };
}

function create_query_wrapper() {
  const query_client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={query_client}>
        {children}
      </QueryClientProvider>
    );
  }
  return { query_client, wrapper };
}
