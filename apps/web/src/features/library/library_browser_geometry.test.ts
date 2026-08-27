import { describe, expect, it } from "vitest";

import type { LibraryFolder } from "@/shared/types";
import {
  folder_ancestors,
  normalized_rectangle,
  rectangles_intersect,
} from "./library_browser_geometry";

function folder(folder_id: string, parent_id: string | null): LibraryFolder {
  return {
    folder_id,
    name: folder_id,
    parent_id,
    materialized_path: `/${folder_id}/`,
    direct_asset_count: 0,
    recursive_asset_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("library browser geometry", () => {
  it("builds the ancestor chain in display order", () => {
    const root = folder("root", null);
    const child = folder("child", root.folder_id);
    const leaf = folder("leaf", child.folder_id);

    expect(folder_ancestors(leaf, [leaf, root, child])).toEqual([
      root,
      child,
      leaf,
    ]);
  });

  it("stops safely when corrupted folder data contains a cycle", () => {
    const first = folder("first", "second");
    const second = folder("second", "first");

    expect(folder_ancestors(first, [first, second])).toEqual([second, first]);
  });

  it("normalizes reverse drags and detects edge intersections", () => {
    const rectangle = normalized_rectangle(12, 14, 2, 4);

    expect(rectangle).toEqual({
      left: 2,
      top: 4,
      right: 12,
      bottom: 14,
      width: 10,
      height: 10,
    });
    expect(
      rectangles_intersect(rectangle, {
        left: 12,
        top: 14,
        right: 20,
        bottom: 20,
      }),
    ).toBe(true);
    expect(
      rectangles_intersect(rectangle, {
        left: 13,
        top: 15,
        right: 20,
        bottom: 20,
      }),
    ).toBe(false);
  });
});
