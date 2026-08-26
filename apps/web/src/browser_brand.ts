const BROWSER_THEME_COLOR_TOKEN = "--browser-theme-color";
const BROWSER_ICON_BACKGROUND_TOKEN = "--browser-icon-background";
const BROWSER_ICON_FOREGROUND_TOKEN = "--browser-icon-foreground";
const THEME_COLOR_META_SELECTOR = 'meta[name="theme-color"]';
const FAVICON_SELECTOR = 'link[rel="icon"]';
const SVG_DATA_PREFIX = "data:image/svg+xml,";

function browser_color_token(document: Document, token_name: string): string {
  const view = document.defaultView;
  if (view === null) {
    throw new Error("无法读取浏览器品牌颜色");
  }
  return view
    .getComputedStyle(document.documentElement)
    .getPropertyValue(token_name)
    .trim();
}

function require_browser_color(color: string, token_name: string): string {
  if (color.length === 0) {
    throw new Error(`浏览器品牌颜色 Token 缺失：${token_name}`);
  }
  return color;
}

export function initialize_browser_brand(document: Document): void {
  const theme_color = require_browser_color(
    browser_color_token(document, BROWSER_THEME_COLOR_TOKEN),
    BROWSER_THEME_COLOR_TOKEN,
  );
  const icon_background = require_browser_color(
    browser_color_token(document, BROWSER_ICON_BACKGROUND_TOKEN),
    BROWSER_ICON_BACKGROUND_TOKEN,
  );
  const icon_foreground = require_browser_color(
    browser_color_token(document, BROWSER_ICON_FOREGROUND_TOKEN),
    BROWSER_ICON_FOREGROUND_TOKEN,
  );

  const theme_meta =
    document.head.querySelector<HTMLMetaElement>(THEME_COLOR_META_SELECTOR) ??
    document.createElement("meta");
  theme_meta.name = "theme-color";
  theme_meta.content = theme_color;
  if (!theme_meta.isConnected) document.head.append(theme_meta);

  const favicon =
    document.head.querySelector<HTMLLinkElement>(FAVICON_SELECTOR) ??
    document.createElement("link");
  const icon_svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${icon_background}"/><path d="M13 10.5v11l9-5.5z" fill="${icon_foreground}"/></svg>`;
  favicon.rel = "icon";
  favicon.href = `${SVG_DATA_PREFIX}${encodeURIComponent(icon_svg)}`;
  if (!favicon.isConnected) document.head.append(favicon);
}
