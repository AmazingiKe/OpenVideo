import { afterEach, describe, expect, it, vi } from "vitest";

import { initialize_color_scheme } from "./color_scheme";

afterEach(() => {
  document.documentElement.classList.remove("dark");
});

describe("initialize_color_scheme", () => {
  it("follows the system preference and updates when it changes", () => {
    const change_listeners: Array<(event: MediaQueryListEvent) => void> = [];
    const media_query = {
      matches: false,
      addEventListener: vi.fn(
        (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          change_listeners.push(listener);
        },
      ),
    } as unknown as MediaQueryList;
    const window_object = {
      matchMedia: vi.fn(() => media_query),
    } as unknown as Pick<Window, "matchMedia">;
    document.documentElement.classList.add("dark");

    initialize_color_scheme(document, window_object);

    expect(window_object.matchMedia).toHaveBeenCalledWith(
      "(prefers-color-scheme: dark)",
    );
    expect(document.documentElement).not.toHaveClass("dark");

    change_listeners[0]?.({ matches: true } as MediaQueryListEvent);
    expect(document.documentElement).toHaveClass("dark");
  });
});
