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
  it("persists workspace display preferences together", async () => {
    const first_render = renderHook(() => use_local_preferences(), { wrapper });

    act(() => {
      first_render.result.current.set_assistant_open(false);
      first_render.result.current.set_color_scheme("dark");
      first_render.result.current.set_summary_player_geometry({
        x: 16,
        y: 24,
        width: 400,
        height: 280,
      });
      first_render.result.current.set_summary_player_open(true);
      first_render.result.current.set_video_library_open(true);
    });

    await waitFor(() =>
      expect(read_local_preferences()).toEqual({
        assistant_open: false,
        color_scheme: "dark",
        summary_player_geometry: {
          x: 16,
          y: 24,
          width: 400,
          height: 280,
        },
        summary_player_open: true,
        video_library_open: true,
      }),
    );
    expect(document.documentElement).toHaveClass("dark");
    first_render.unmount();

    const restored_render = renderHook(() => use_local_preferences(), {
      wrapper,
    });
    expect(restored_render.result.current.preferences).toEqual({
      assistant_open: false,
      color_scheme: "dark",
      summary_player_geometry: {
        x: 16,
        y: 24,
        width: 400,
        height: 280,
      },
      summary_player_open: true,
      video_library_open: true,
    });
  });

  it("ignores damaged and invalid stored fields", () => {
    window.localStorage.setItem(LOCAL_PREFERENCES_STORAGE_KEY, "{not-json");
    expect(read_local_preferences()).toEqual({
      assistant_open: null,
      color_scheme: null,
      summary_player_geometry: null,
      summary_player_open: null,
      video_library_open: null,
    });

    window.localStorage.setItem(
      LOCAL_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        assistant_open: "yes",
        color_scheme: "sepia",
        summary_player_geometry: { x: 16, y: 24, width: "wide", height: 280 },
        summary_player_open: "yes",
        video_library_open: true,
      }),
    );
    expect(read_local_preferences()).toEqual({
      assistant_open: null,
      color_scheme: null,
      summary_player_geometry: null,
      summary_player_open: null,
      video_library_open: true,
    });
  });
});
