import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import {
  LOCAL_PREFERENCES_STORAGE_KEY,
  LocalPreferencesProvider,
  read_local_preferences,
  use_local_preferences,
} from "@/app/local_preferences";

function wrapper({ children }: { children: ReactNode }) {
  return <LocalPreferencesProvider>{children}</LocalPreferencesProvider>;
}

describe("LocalPreferencesProvider", () => {
  it("drops a previously stored light theme while preserving workspace preferences", async () => {
    window.localStorage.setItem(
      LOCAL_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        color_scheme: "light",
        assistant_open: false,
        video_library_open: true,
      }),
    );
    const { result } = renderHook(() => use_local_preferences(), { wrapper });
    expect(result.current.preferences).toMatchObject({
      assistant_open: false,
      video_library_open: true,
    });
    expect(result.current.preferences).not.toHaveProperty("color_scheme");
    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem(LOCAL_PREFERENCES_STORAGE_KEY)!,
      );
      expect(stored).not.toHaveProperty("color_scheme");
      expect(stored.assistant_open).toBe(false);
      expect(stored.video_library_open).toBe(true);
    });
  });

  it("persists each video's player state independently", async () => {
    const first_render = renderHook(() => use_local_preferences(), { wrapper });

    act(() => {
      first_render.result.current.set_assistant_open(false);
      first_render.result.current.set_summary_player_geometry("asset-first", {
        x: 16,
        y: 24,
        width: 400,
        height: 280,
      });
      first_render.result.current.set_summary_player_open("asset-first", true);
      first_render.result.current.set_summary_player_geometry("asset-second", {
        x: 80,
        y: 96,
        width: 640,
        height: 360,
      });
      first_render.result.current.set_summary_player_open(
        "asset-second",
        false,
      );
      first_render.result.current.set_video_library_open(true);
    });

    await waitFor(() =>
      expect(read_local_preferences()).toEqual({
        assistant_open: false,
        summary_player_states: {
          "asset-first": {
            geometry: { x: 16, y: 24, width: 400, height: 280 },
            open: true,
          },
          "asset-second": {
            geometry: { x: 80, y: 96, width: 640, height: 360 },
            open: false,
          },
        },
        video_library_open: true,
      }),
    );
    first_render.unmount();

    const restored_render = renderHook(() => use_local_preferences(), {
      wrapper,
    });
    expect(restored_render.result.current.preferences).toEqual({
      assistant_open: false,
      summary_player_states: {
        "asset-first": {
          geometry: { x: 16, y: 24, width: 400, height: 280 },
          open: true,
        },
        "asset-second": {
          geometry: { x: 80, y: 96, width: 640, height: 360 },
          open: false,
        },
      },
      video_library_open: true,
    });
  });

  it("ignores damaged and invalid stored fields", () => {
    window.localStorage.setItem(LOCAL_PREFERENCES_STORAGE_KEY, "{not-json");
    expect(read_local_preferences()).toEqual({
      assistant_open: null,
      summary_player_states: {},
      video_library_open: null,
    });

    window.localStorage.setItem(
      LOCAL_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        assistant_open: "yes",
        summary_player_states: {
          "asset-damaged": {
            geometry: { x: 16, y: 24, width: "wide", height: 280 },
            open: "yes",
          },
        },
        video_library_open: true,
      }),
    );
    expect(read_local_preferences()).toEqual({
      assistant_open: null,
      summary_player_states: {},
      video_library_open: true,
    });
  });
});
