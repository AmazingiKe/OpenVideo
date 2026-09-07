import { describe, expect, it } from "vitest";
import { format_marker_label } from "./marker_labels";
import type { MarkerImportance } from "./types";

describe("marker labels", () => {
  it.each([
    ["推导过程", 0, "推导过程 · 00:10"],
    ["", 3, "★★★ · 00:10"],
    ["推导过程", 3, "推导过程 · ★★★ · 00:10"],
    [" \n ", 0, "未评分 · 00:10"],
  ])("shows content %s with importance %s", (content, importance, expected) => {
    expect(
      format_marker_label({
        content,
        importance: importance as MarkerImportance,
        start_seconds: 10,
      }),
    ).toBe(expected);
  });
});
