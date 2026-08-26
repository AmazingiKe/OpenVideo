import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initialize_browser_brand } from "./browser_brand";

const THEME_TOKEN_VALUE = "theme-token-value";
const ICON_BACKGROUND_TOKEN_VALUE = "icon-background-token-value";
const ICON_FOREGROUND_TOKEN_VALUE = "icon-foreground-token-value";
const SVG_DATA_PREFIX = "data:image/svg+xml,";

describe("initialize_browser_brand", () => {
  beforeEach(() => {
    document.documentElement.style.setProperty(
      "--browser-theme-color",
      THEME_TOKEN_VALUE,
    );
    document.documentElement.style.setProperty(
      "--browser-icon-background",
      ICON_BACKGROUND_TOKEN_VALUE,
    );
    document.documentElement.style.setProperty(
      "--browser-icon-foreground",
      ICON_FOREGROUND_TOKEN_VALUE,
    );
  });

  afterEach(() => {
    document.documentElement.removeAttribute("style");
    document.head.querySelector('meta[name="theme-color"]')?.remove();
    document.head.querySelector('link[rel="icon"]')?.remove();
  });

  it("creates browser branding from global color tokens", () => {
    initialize_browser_brand(document);

    expect(
      document.head.querySelector('meta[name="theme-color"]'),
    ).toHaveAttribute("content", THEME_TOKEN_VALUE);
    const favicon =
      document.head.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(favicon).not.toBeNull();
    const icon_svg = decodeURIComponent(
      favicon!.getAttribute("href")!.slice(SVG_DATA_PREFIX.length),
    );
    expect(icon_svg).toContain(`fill="${ICON_BACKGROUND_TOKEN_VALUE}"`);
    expect(icon_svg).toContain(`fill="${ICON_FOREGROUND_TOKEN_VALUE}"`);
  });
});
