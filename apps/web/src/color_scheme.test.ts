import { afterEach, describe, expect, it, vi } from "vitest";

import {
  apply_user_color_scheme,
  current_color_scheme,
  initialize_color_scheme,
  subscribe_color_scheme,
} from "./color_scheme";

afterEach(() => {
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-color-scheme-source");
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
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList;
    const window_object = {
      matchMedia: vi.fn(() => media_query),
    } as unknown as Pick<Window, "matchMedia">;
    document.documentElement.classList.add("dark");

    const dispose = initialize_color_scheme(document, window_object);

    expect(window_object.matchMedia).toHaveBeenCalledWith(
      "(prefers-color-scheme: dark)",
    );
    expect(document.documentElement).not.toHaveClass("dark");

    change_listeners[0]?.({ matches: true } as MediaQueryListEvent);
    expect(document.documentElement).toHaveClass("dark");

    dispose();
    expect(media_query.removeEventListener).toHaveBeenCalledWith(
      "change",
      change_listeners[0],
    );
  });

  it("keeps the user selection when the system preference changes", () => {
    const change_listeners: Array<(event: MediaQueryListEvent) => void> = [];
    const media_query = {
      matches: false,
      addEventListener: vi.fn(
        (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          change_listeners.push(listener);
        },
      ),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList;
    const listener = vi.fn();
    const unsubscribe = subscribe_color_scheme(listener, document);

    initialize_color_scheme(document, {
      matchMedia: vi.fn(() => media_query),
    });
    expect(current_color_scheme(document)).toBe("light");

    apply_user_color_scheme(document, "dark");
    expect(current_color_scheme(document)).toBe("dark");
    expect(listener).toHaveBeenCalledOnce();

    change_listeners[0]?.({ matches: false } as MediaQueryListEvent);
    expect(current_color_scheme(document)).toBe("dark");
    unsubscribe();
  });

  it("applies a persisted user preference before following the system", () => {
    const change_listener = vi.fn();
    const media_query = {
      matches: false,
      addEventListener: vi.fn(
        (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          change_listener.mockImplementation(listener);
        },
      ),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList;

    initialize_color_scheme(
      document,
      { matchMedia: vi.fn(() => media_query) },
      "dark",
    );

    expect(current_color_scheme(document)).toBe("dark");
    change_listener({ matches: false } as MediaQueryListEvent);
    expect(current_color_scheme(document)).toBe("dark");
  });
});
