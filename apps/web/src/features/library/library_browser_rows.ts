import type { LibraryFolder, MediaAsset } from "@/shared/types";
import type { LibraryViewMode } from "./LibraryBrowserItems";

export const LIBRARY_GRID_GAP_PX = 12;

export type LibraryBrowserItem =
  | { kind: "folder"; id: string; folder: LibraryFolder }
  | { kind: "video"; id: string; asset: MediaAsset };

export type LibraryBrowserRow = {
  key: string;
  items: LibraryBrowserItem[];
};

export function library_browser_column_count(
  container_width: number,
  thumbnail_size: number,
): number {
  if (container_width <= 0) return 1;
  const minimum_column_width = Math.min(container_width, thumbnail_size);
  return Math.max(
    1,
    Math.floor(
      (container_width + LIBRARY_GRID_GAP_PX) /
        (minimum_column_width + LIBRARY_GRID_GAP_PX),
    ),
  );
}

export function create_library_browser_items(
  folders: LibraryFolder[],
  assets: MediaAsset[],
): LibraryBrowserItem[] {
  return [
    ...folders.map((folder): LibraryBrowserItem => ({
      kind: "folder",
      id: folder.folder_id,
      folder,
    })),
    ...assets.map((asset): LibraryBrowserItem => ({
      kind: "video",
      id: asset.asset_id,
      asset,
    })),
  ];
}

export function create_library_browser_rows(
  items: LibraryBrowserItem[],
  view_mode: LibraryViewMode,
  column_count: number,
): LibraryBrowserRow[] {
  const items_per_row = view_mode === "grid" ? Math.max(1, column_count) : 1;
  const rows: LibraryBrowserRow[] = [];
  for (let index = 0; index < items.length; index += items_per_row) {
    const row_items = items.slice(index, index + items_per_row);
    rows.push({
      key: row_items.map((item) => `${item.kind}:${item.id}`).join("|"),
      items: row_items,
    });
  }
  return rows;
}

export function library_item_row_index(
  rows: LibraryBrowserRow[],
  item_id: string,
): number {
  return rows.findIndex((row) => row.items.some((item) => item.id === item_id));
}
