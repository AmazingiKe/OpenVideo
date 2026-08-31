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
  it("persists assistant, color scheme and video library visibility together", async () => {
    const first_render = renderHook(() => use_local_preferences(), { wrapper });

    act(() => {
      first_render.result.current.set_assistant_open(false);
      first_render.result.current.set_color_scheme("dark");
      first_render.result.current.set_video_library_open(true);
    });

    await waitFor(() =>
      expect(read_local_preferences()).toEqual({
        assistant_open: false,
        color_scheme: "dark",
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
      video_library_open: true,
    });
  });

  it("ignores damaged and invalid stored fields", () => {
    window.localStorage.setItem(LOCAL_PREFERENCES_STORAGE_KEY, "{not-json");
    expect(read_local_preferences()).toEqual({
      assistant_open: null,
      color_scheme: null,
      video_library_open: null,
    });

    window.localStorage.setItem(
      LOCAL_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        assistant_open: "yes",
        color_scheme: "sepia",
        video_library_open: true,
      }),
    );
    expect(read_local_preferences()).toEqual({
      assistant_open: null,
      color_scheme: null,
      video_library_open: true,
    });
  });
});
