import type { LibraryFolder } from "@/shared/types";

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
