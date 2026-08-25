import type { LibraryFolder } from "@/shared/types";

export const STORY_FOLDERS: LibraryFolder[] = [
  {
    folder_id: "folder-019c0000000070008000000000000001",
    name: "课程",
    parent_id: null,
    materialized_path: "/folder-019c0000000070008000000000000001/",
    direct_asset_count: 2,
    recursive_asset_count: 4,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    folder_id: "folder-019c0000000070008000000000000002",
    name: "镜头语言",
    parent_id: "folder-019c0000000070008000000000000001",
    materialized_path:
      "/folder-019c0000000070008000000000000001/folder-019c0000000070008000000000000002/",
    direct_asset_count: 2,
    recursive_asset_count: 2,
    created_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  },
];
