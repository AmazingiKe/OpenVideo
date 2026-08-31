import { describe, expect, it } from "vitest";

import type { LibraryFolder } from "@/shared/types";
import { folder_ancestors, has_descendants } from "./library_folder_tree";

const ROOT_FOLDER = folder(
  "folder-019c0000000070008000000000000001",
  null,
  "/folder-019c0000000070008000000000000001/",
);
const CHILD_FOLDER = folder(
  "folder-019c0000000070008000000000000002",
  ROOT_FOLDER.folder_id,
  `${ROOT_FOLDER.materialized_path}folder-019c0000000070008000000000000002/`,
);
const GRANDCHILD_FOLDER = folder(
  "folder-019c0000000070008000000000000003",
  CHILD_FOLDER.folder_id,
  `${CHILD_FOLDER.materialized_path}folder-019c0000000070008000000000000003/`,
);

describe("library folder tree", () => {
  it("returns ancestors from the root to the current folder", () => {
    expect(
      folder_ancestors(GRANDCHILD_FOLDER, [
        GRANDCHILD_FOLDER,
        ROOT_FOLDER,
        CHILD_FOLDER,
      ]),
    ).toEqual([ROOT_FOLDER, CHILD_FOLDER, GRANDCHILD_FOLDER]);
  });

  it("stops safely when folder parents contain a cycle", () => {
    const cyclic_root = {
      ...ROOT_FOLDER,
      parent_id: GRANDCHILD_FOLDER.folder_id,
    };
    expect(
      folder_ancestors(GRANDCHILD_FOLDER, [
        cyclic_root,
        CHILD_FOLDER,
        GRANDCHILD_FOLDER,
      ]),
    ).toEqual([cyclic_root, CHILD_FOLDER, GRANDCHILD_FOLDER]);
  });

  it("detects nested folders without treating the folder itself as a child", () => {
    expect(has_descendants(ROOT_FOLDER, [ROOT_FOLDER, CHILD_FOLDER])).toBe(
      true,
    );
    expect(has_descendants(CHILD_FOLDER, [ROOT_FOLDER, CHILD_FOLDER])).toBe(
      false,
    );
  });
});

function folder(
  folder_id: string,
  parent_id: string | null,
  materialized_path: string,
): LibraryFolder {
  return {
    folder_id,
    name: folder_id,
    parent_id,
    materialized_path,
    direct_asset_count: 0,
    recursive_asset_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}
