import type { LibraryFolder } from "@/shared/types";

export type SelectionRectangle = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function folder_ancestors(
  folder: LibraryFolder | null,
  folders: LibraryFolder[],
): LibraryFolder[] {
  if (!folder) return [];
  const folders_by_id = new Map(
    folders.map((candidate) => [candidate.folder_id, candidate]),
  );
  const ancestors = [folder];
  const visited_folder_ids = new Set([folder.folder_id]);
  let parent_id = folder.parent_id;
  while (parent_id) {
    if (visited_folder_ids.has(parent_id)) break;
    const parent = folders_by_id.get(parent_id);
    if (!parent) break;
    ancestors.unshift(parent);
    visited_folder_ids.add(parent.folder_id);
    parent_id = parent.parent_id;
  }
  return ancestors;
}

export function has_descendants(
  folder: LibraryFolder,
  folders: LibraryFolder[],
): boolean {
  return folders.some(
    (candidate) =>
      candidate.folder_id !== folder.folder_id &&
      candidate.materialized_path.startsWith(folder.materialized_path),
  );
}

export function normalized_rectangle(
  start_x: number,
  start_y: number,
  end_x: number,
  end_y: number,
): SelectionRectangle & { right: number; bottom: number } {
  const left = Math.min(start_x, end_x);
  const top = Math.min(start_y, end_y);
  const right = Math.max(start_x, end_x);
  const bottom = Math.max(start_y, end_y);
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

export function rectangles_intersect(
  first: { left: number; top: number; right: number; bottom: number },
  second: { left: number; top: number; right: number; bottom: number },
) {
  return !(
    first.right < second.left ||
    first.left > second.right ||
    first.bottom < second.top ||
    first.top > second.bottom
  );
}
