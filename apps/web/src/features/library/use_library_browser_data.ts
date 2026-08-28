import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import { list_assets, list_folders } from "@/shared/api";
import type { LibraryFolder, MediaAsset } from "@/shared/types";
import type { LibraryViewMode } from "./LibraryBrowserItems";
import {
  DEFAULT_THUMBNAIL_SIZE_PX,
  type SortValue,
} from "./LibraryBrowserToolbar";
import { folder_ancestors } from "./library_browser_geometry";

const EMPTY_FOLDERS: LibraryFolder[] = [];
const EMPTY_ASSETS: MediaAsset[] = [];
const COMPACT_THUMBNAIL_SIZE_PX = 160;

const SORT_PARAMETERS: Record<
  SortValue,
  ["created_at" | "title" | "duration", "asc" | "desc"]
> = {
  created_at_desc: ["created_at", "desc"],
  created_at_asc: ["created_at", "asc"],
  title_asc: ["title", "asc"],
  duration_desc: ["duration", "desc"],
};

export function use_library_browser_data(
  compact: boolean,
  initial_folder_id: string | null | undefined,
) {
  const query_client = useQueryClient();
  const [current_folder_id, set_current_folder_id] = useState<string | null>(
    null,
  );
  const initial_folder_applied_ref = useRef(false);
  const [search, set_search] = useState("");
  const deferred_search = useDeferredValue(search.trim());
  const [sort_value, set_sort_value] = useState<SortValue>("created_at_desc");
  const [view_mode, set_view_mode] = useState<LibraryViewMode>("grid");
  const [thumbnail_size, set_thumbnail_size] = useState(
    compact ? COMPACT_THUMBNAIL_SIZE_PX : DEFAULT_THUMBNAIL_SIZE_PX,
  );

  const folders_query = useQuery({
    queryKey: RESOURCE_QUERY_KEYS.library_folders,
    queryFn: ({ signal }) => list_folders(signal),
  });
  const folders = folders_query.data ?? EMPTY_FOLDERS;
  const [sort_by, sort_order] = SORT_PARAMETERS[sort_value];
  const assets_query = useQuery({
    queryKey: [
      ...RESOURCE_QUERY_KEYS.assets,
      "library_browser",
      current_folder_id,
      deferred_search,
      sort_value,
    ],
    queryFn: ({ signal }) =>
      list_assets(signal, {
        folder_id:
          deferred_search || current_folder_id === null
            ? undefined
            : current_folder_id,
        uncategorized: !deferred_search && current_folder_id === null,
        search: deferred_search || undefined,
        sort_by,
        sort_order,
      }),
  });
  const assets = assets_query.data ?? EMPTY_ASSETS;
  const current_folder = folders.find(
    (folder) => folder.folder_id === current_folder_id,
  );
  const direct_folders = useMemo(
    () =>
      deferred_search
        ? EMPTY_FOLDERS
        : folders
            .filter((folder) => folder.parent_id === current_folder_id)
            .sort((left, right) =>
              left.name.localeCompare(right.name, "zh-CN"),
            ),
    [current_folder_id, deferred_search, folders],
  );
  const breadcrumbs = useMemo(
    () => folder_ancestors(current_folder ?? null, folders),
    [current_folder, folders],
  );

  useEffect(() => {
    if (
      initial_folder_applied_ref.current ||
      initial_folder_id === undefined ||
      folders_query.isPending
    ) {
      return;
    }
    initial_folder_applied_ref.current = true;
    const folder_exists =
      initial_folder_id === null ||
      folders.some((folder) => folder.folder_id === initial_folder_id);
    set_current_folder_id(folder_exists ? initial_folder_id : null);
  }, [folders, folders_query.isPending, initial_folder_id]);

  useEffect(() => {
    if (
      current_folder_id !== null &&
      folders_query.isFetched &&
      !folders.some((folder) => folder.folder_id === current_folder_id)
    ) {
      set_current_folder_id(null);
    }
  }, [current_folder_id, folders, folders_query.isFetched]);

  async function refresh_library() {
    await Promise.all([
      query_client.invalidateQueries({
        queryKey: RESOURCE_QUERY_KEYS.library_folders,
      }),
      query_client.invalidateQueries({ queryKey: RESOURCE_QUERY_KEYS.assets }),
    ]);
  }

  return {
    assets,
    breadcrumbs,
    current_folder,
    current_folder_id,
    deferred_search,
    direct_folders,
    folders,
    load_error: folders_query.error ?? assets_query.error,
    loading: folders_query.isPending || assets_query.isPending,
    refresh_library,
    search,
    set_current_folder_id,
    set_search,
    set_sort_value,
    set_thumbnail_size,
    set_view_mode,
    sort_value,
    thumbnail_size,
    view_mode,
    visible_item_count: direct_folders.length + assets.length,
  };
}
