import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FolderTree } from "@/features/library/FolderTree";
import { folder_path_label } from "@/features/library/MoveToFolderDialog";
import type { LibraryFolder } from "@/shared/types";

const ROOT: LibraryFolder = {
  folder_id: "folder-019c0000000070008000000000000001",
  name: "课程",
  parent_id: null,
  materialized_path: "/folder-019c0000000070008000000000000001/",
  direct_asset_count: 1,
  recursive_asset_count: 2,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};
const CHILD: LibraryFolder = {
  ...ROOT,
  folder_id: "folder-019c0000000070008000000000000002",
  name: "镜头",
  parent_id: ROOT.folder_id,
  materialized_path: `${ROOT.materialized_path}folder-019c0000000070008000000000000002/`,
  direct_asset_count: 1,
  recursive_asset_count: 1,
};

describe("FolderTree", () => {
  it("renders expanded nested folders and selects the current layer", () => {
    const on_select = vi.fn();
    render(
      <FolderTree
        folders={[ROOT, CHILD]}
        selected_scope="all"
        expanded_folder_ids={new Set([ROOT.folder_id])}
        uncategorized_count={3}
        on_select={on_select}
        on_toggle={vi.fn()}
        on_create={vi.fn()}
        on_rename={vi.fn()}
        on_move={vi.fn()}
        on_delete={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "镜头，1 个视频" }),
    );
    expect(on_select).toHaveBeenCalledWith(CHILD.folder_id);
    expect(
      screen.getByRole("button", { name: "未分类，3 个视频" }),
    ).toBeVisible();
  });

  it("builds readable nested destination labels", () => {
    expect(folder_path_label(CHILD, [ROOT, CHILD])).toBe("课程 / 镜头");
  });
});
