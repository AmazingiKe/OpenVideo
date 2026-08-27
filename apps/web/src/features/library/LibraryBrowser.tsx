import {
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckSquare,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Library,
  Pencil,
  Play,
  Search,
  Trash2,
} from "lucide-react";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import {
  create_folder,
  delete_asset,
  delete_folder,
  list_assets,
  list_folders,
  move_assets,
  move_folder,
  rename_folder,
} from "@/shared/api";
import { error_message } from "@/shared/errors";
import type { LibraryFolder, MediaAsset } from "@/shared/types";
import {
  FolderItem,
  LibraryBrowserSkeleton,
  VideoItem,
  type LibraryViewMode,
} from "./LibraryBrowserItems";
import {
  LibraryBrowserDialogs,
  type FolderEditor,
  type MoveTarget,
} from "./LibraryBrowserDialogs";
import {
  DEFAULT_THUMBNAIL_SIZE_PX,
  LibraryBrowserToolbar,
  type SortValue,
} from "./LibraryBrowserToolbar";
import {
  folder_ancestors,
  has_descendants,
  normalized_rectangle,
  rectangles_intersect,
  type SelectionRectangle,
} from "./library_browser_geometry";

type LibraryBrowserProps = {
  current_video_id?: string | null;
  initial_folder_id?: string | null;
  compact?: boolean;
  className?: string;
  on_open_video: (asset: MediaAsset) => void | Promise<void>;
};

type FocusedItem =
  { kind: "folder"; id: string } | { kind: "video"; id: string } | null;

type ContextTarget = "background" | FocusedItem;

type MarqueeGesture = {
  pointer_id: number;
  start_x: number;
  start_y: number;
  base_selection: Set<string>;
};

const EMPTY_FOLDERS: LibraryFolder[] = [];
const EMPTY_ASSETS: MediaAsset[] = [];
const SEARCH_INPUT_SELECTOR =
  'input, textarea, select, [contenteditable="true"]';
const LIBRARY_ITEM_SELECTOR = '[data-library-item="true"]';
const MARQUEE_DRAG_THRESHOLD_PX = 3;
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

export function LibraryBrowser({
  current_video_id = null,
  initial_folder_id,
  compact = false,
  className,
  on_open_video,
}: LibraryBrowserProps) {
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
  const [selected_folder_id, set_selected_folder_id] = useState<string | null>(
    null,
  );
  const [selected_asset_ids, set_selected_asset_ids] = useState<Set<string>>(
    new Set(),
  );
  const [focused_item, set_focused_item] = useState<FocusedItem>(null);
  const [context_target, set_context_target] =
    useState<ContextTarget>("background");
  const [dragging_asset_ids, set_dragging_asset_ids] = useState<string[]>([]);
  const [drop_folder_id, set_drop_folder_id] = useState<string | null>(null);
  const [folder_editor, set_folder_editor] = useState<FolderEditor | null>(
    null,
  );
  const [folder_name, set_folder_name] = useState("");
  const [move_target, set_move_target] = useState<MoveTarget>(null);
  const [asset_ids_to_delete, set_asset_ids_to_delete] = useState<string[]>([]);
  const [folder_to_delete, set_folder_to_delete] =
    useState<LibraryFolder | null>(null);
  const [folder_confirmation, set_folder_confirmation] = useState("");
  const [submitting, set_submitting] = useState(false);
  const [operation_error, set_operation_error] = useState<string | null>(null);
  const [selection_rectangle, set_selection_rectangle] =
    useState<SelectionRectangle | null>(null);
  const selection_anchor_id_ref = useRef<string | null>(null);
  const marquee_gesture_ref = useRef<MarqueeGesture | null>(null);

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
  const all_visible_videos_selected =
    assets.length > 0 && selected_asset_ids.size === assets.length;
  const visible_item_count = direct_folders.length + assets.length;
  const loading = folders_query.isPending || assets_query.isPending;
  const load_error = folders_query.error ?? assets_query.error;

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

  useEffect(() => {
    const visible_asset_ids = new Set(assets.map((asset) => asset.asset_id));
    set_selected_asset_ids((current) => {
      const next = new Set(
        [...current].filter((asset_id) => visible_asset_ids.has(asset_id)),
      );
      return next.size === current.size ? current : next;
    });
    if (
      selection_anchor_id_ref.current &&
      !visible_asset_ids.has(selection_anchor_id_ref.current)
    ) {
      selection_anchor_id_ref.current = null;
    }
  }, [assets]);

  async function refresh_library() {
    await Promise.all([
      query_client.invalidateQueries({
        queryKey: RESOURCE_QUERY_KEYS.library_folders,
      }),
      query_client.invalidateQueries({ queryKey: RESOURCE_QUERY_KEYS.assets }),
    ]);
  }

  function clear_selection() {
    set_selected_folder_id(null);
    set_selected_asset_ids(new Set());
    selection_anchor_id_ref.current = null;
  }

  function navigate_to_folder(folder_id: string | null) {
    set_current_folder_id(folder_id);
    set_focused_item(null);
    clear_selection();
  }

  function navigate_to_parent() {
    if (deferred_search) return;
    navigate_to_folder(current_folder?.parent_id ?? null);
  }

  function select_folder(folder_id: string) {
    set_selected_folder_id(folder_id);
    set_selected_asset_ids(new Set());
    selection_anchor_id_ref.current = null;
    set_focused_item({ kind: "folder", id: folder_id });
  }

  function select_video(
    asset_id: string,
    options: { additive: boolean; range: boolean },
  ) {
    const visible_asset_ids = assets.map((asset) => asset.asset_id);
    const asset_index = visible_asset_ids.indexOf(asset_id);
    const anchor_index = selection_anchor_id_ref.current
      ? visible_asset_ids.indexOf(selection_anchor_id_ref.current)
      : -1;
    let next: Set<string>;

    if (options.range && anchor_index >= 0 && asset_index >= 0) {
      const range_start = Math.min(anchor_index, asset_index);
      const range_end = Math.max(anchor_index, asset_index);
      next = options.additive ? new Set(selected_asset_ids) : new Set<string>();
      visible_asset_ids
        .slice(range_start, range_end + 1)
        .forEach((visible_asset_id) => next.add(visible_asset_id));
    } else if (options.additive) {
      next = new Set(selected_asset_ids);
      if (next.has(asset_id)) next.delete(asset_id);
      else next.add(asset_id);
    } else {
      next = new Set([asset_id]);
    }

    set_selected_folder_id(null);
    set_selected_asset_ids(next);
    selection_anchor_id_ref.current = asset_id;
    set_focused_item({ kind: "video", id: asset_id });
  }

  function toggle_focused_video(asset_id: string) {
    select_video(asset_id, { additive: true, range: false });
  }

  function select_all_videos() {
    if (all_visible_videos_selected) {
      clear_selection();
      return;
    }
    set_selected_folder_id(null);
    set_selected_asset_ids(new Set(assets.map((asset) => asset.asset_id)));
    const last_asset_id = assets.at(-1)?.asset_id ?? null;
    selection_anchor_id_ref.current = last_asset_id;
    set_focused_item(
      last_asset_id ? { kind: "video", id: last_asset_id } : null,
    );
  }

  async function open_asset(asset: MediaAsset) {
    if (asset.status !== "ready") return;
    set_operation_error(null);
    try {
      await on_open_video(asset);
    } catch (error) {
      set_operation_error(error_message(error));
    }
  }

  function open_focused_item(item: FocusedItem) {
    if (!item) return;
    if (item.kind === "folder") {
      navigate_to_folder(item.id);
      return;
    }
    const asset = assets.find((candidate) => candidate.asset_id === item.id);
    if (asset) void open_asset(asset);
  }

  function handle_key_down(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.matches(SEARCH_INPUT_SELECTOR)) return;
    const target_item = target?.closest<HTMLElement>(LIBRARY_ITEM_SELECTOR);
    const target_kind = target_item?.dataset.libraryKind;
    const target_id = target_item?.dataset.libraryId;
    const keyboard_item: FocusedItem =
      target_id && (target_kind === "folder" || target_kind === "video")
        ? { kind: target_kind, id: target_id }
        : focused_item;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      select_all_videos();
      return;
    }
    if (event.key === "Escape") {
      clear_selection();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      open_focused_item(keyboard_item);
      return;
    }
    if (event.key === " " && keyboard_item?.kind === "video") {
      event.preventDefault();
      toggle_focused_video(keyboard_item.id);
      return;
    }
    if (
      (event.key === "Backspace" ||
        (event.altKey && event.key === "ArrowLeft")) &&
      !deferred_search &&
      current_folder_id !== null
    ) {
      event.preventDefault();
      navigate_to_parent();
    }
  }

  function handle_pointer_down(event: PointerEvent<HTMLDivElement>) {
    if (
      event.button !== 0 ||
      (event.pointerType && event.pointerType !== "mouse")
    ) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-library-item]")) return;

    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    const base_selection =
      event.ctrlKey || event.metaKey
        ? new Set(selected_asset_ids)
        : new Set<string>();
    marquee_gesture_ref.current = {
      pointer_id: event.pointerId,
      start_x: event.clientX,
      start_y: event.clientY,
      base_selection,
    };
    set_selected_folder_id(null);
    set_selected_asset_ids(base_selection);
    selection_anchor_id_ref.current = null;
    set_selection_rectangle(null);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handle_pointer_move(event: PointerEvent<HTMLDivElement>) {
    const gesture = marquee_gesture_ref.current;
    if (!gesture || gesture.pointer_id !== event.pointerId) return;
    const horizontal_distance = Math.abs(event.clientX - gesture.start_x);
    const vertical_distance = Math.abs(event.clientY - gesture.start_y);
    if (
      horizontal_distance < MARQUEE_DRAG_THRESHOLD_PX &&
      vertical_distance < MARQUEE_DRAG_THRESHOLD_PX
    ) {
      return;
    }

    const selection_bounds = normalized_rectangle(
      gesture.start_x,
      gesture.start_y,
      event.clientX,
      event.clientY,
    );
    const container_bounds = event.currentTarget.getBoundingClientRect();
    set_selection_rectangle({
      left: selection_bounds.left - container_bounds.left,
      top: selection_bounds.top - container_bounds.top,
      width: selection_bounds.width,
      height: selection_bounds.height,
    });
    const next = new Set(gesture.base_selection);
    event.currentTarget
      .querySelectorAll<HTMLElement>('[data-library-kind="video"]')
      .forEach((card) => {
        const asset_id = card.dataset.libraryId;
        if (
          asset_id &&
          rectangles_intersect(selection_bounds, card.getBoundingClientRect())
        ) {
          next.add(asset_id);
        }
      });
    set_selected_asset_ids(next);
  }

  function finish_marquee_selection(event: PointerEvent<HTMLDivElement>) {
    const gesture = marquee_gesture_ref.current;
    if (!gesture || gesture.pointer_id !== event.pointerId) return;
    marquee_gesture_ref.current = null;
    set_selection_rectangle(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handle_context_menu(event: MouseEvent<HTMLDivElement>) {
    const target = event.target instanceof Element ? event.target : null;
    const item = target?.closest<HTMLElement>("[data-library-item]");
    const item_id = item?.dataset.libraryId;
    const item_kind = item?.dataset.libraryKind;
    if (!item_id || (item_kind !== "folder" && item_kind !== "video")) {
      set_context_target("background");
      return;
    }
    const next_target = { kind: item_kind, id: item_id } as FocusedItem;
    set_context_target(next_target);
    set_focused_item(next_target);
    if (item_kind === "folder") {
      select_folder(item_id);
    } else if (!selected_asset_ids.has(item_id)) {
      select_video(item_id, { additive: false, range: false });
    }
  }

  function handle_video_drag_start(
    event: DragEvent<HTMLButtonElement>,
    asset: MediaAsset,
  ) {
    const dragged_ids = selected_asset_ids.has(asset.asset_id)
      ? [...selected_asset_ids]
      : [asset.asset_id];
    if (!selected_asset_ids.has(asset.asset_id)) {
      select_video(asset.asset_id, { additive: false, range: false });
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", asset.title);
    set_dragging_asset_ids(dragged_ids);
  }

  function handle_folder_drag_over(
    event: DragEvent<HTMLButtonElement>,
    folder_id: string,
  ) {
    if (dragging_asset_ids.length === 0) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    set_drop_folder_id(folder_id);
  }

  async function handle_folder_drop(
    event: DragEvent<HTMLButtonElement>,
    folder_id: string,
  ) {
    if (dragging_asset_ids.length === 0) return;
    event.preventDefault();
    const asset_ids = dragging_asset_ids;
    set_drop_folder_id(null);
    set_dragging_asset_ids([]);
    await move_assets_to_folder(asset_ids, folder_id);
  }

  function open_folder_editor(editor: FolderEditor) {
    set_folder_editor(editor);
    set_folder_name(editor.folder?.name ?? "");
    set_operation_error(null);
  }

  async function submit_folder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!folder_editor || !folder_name.trim()) return;
    set_submitting(true);
    set_operation_error(null);
    try {
      if (folder_editor.mode === "create") {
        const created = await create_folder(
          folder_name.trim(),
          folder_editor.parent_id,
        );
        set_current_folder_id(created.folder_id);
      } else if (folder_editor.folder) {
        await rename_folder(folder_editor.folder.folder_id, folder_name.trim());
      }
      set_folder_editor(null);
      await refresh_library();
    } catch (error) {
      set_operation_error(error_message(error));
    } finally {
      set_submitting(false);
    }
  }

  function open_assets_move(asset_ids: string[]) {
    const moving_assets = assets.filter((asset) =>
      asset_ids.includes(asset.asset_id),
    );
    const source_folder_ids = new Set(
      moving_assets.map((asset) => asset.folder_id ?? null),
    );
    set_move_target({
      kind: "assets",
      asset_ids,
      initial_folder_id:
        source_folder_ids.size === 1
          ? (source_folder_ids.values().next().value ?? null)
          : null,
    });
    set_operation_error(null);
  }

  async function submit_move(folder_id: string | null) {
    if (!move_target) return;
    set_submitting(true);
    set_operation_error(null);
    try {
      if (move_target.kind === "assets") {
        await move_assets(move_target.asset_ids, folder_id);
        clear_selection();
      } else {
        await move_folder(move_target.folder.folder_id, folder_id);
      }
      set_move_target(null);
      await refresh_library();
    } catch (error) {
      set_operation_error(error_message(error));
    } finally {
      set_submitting(false);
    }
  }

  async function move_assets_to_folder(asset_ids: string[], folder_id: string) {
    set_submitting(true);
    set_operation_error(null);
    try {
      await move_assets(asset_ids, folder_id);
      clear_selection();
      await refresh_library();
    } catch (error) {
      set_operation_error(error_message(error));
    } finally {
      set_submitting(false);
    }
  }

  async function confirm_asset_delete() {
    if (asset_ids_to_delete.length === 0) return;
    set_submitting(true);
    set_operation_error(null);
    try {
      await Promise.all(
        asset_ids_to_delete.map((asset_id) => delete_asset(asset_id)),
      );
      set_asset_ids_to_delete([]);
      clear_selection();
      await refresh_library();
    } catch (error) {
      set_operation_error(error_message(error));
    } finally {
      set_submitting(false);
    }
  }

  async function confirm_folder_delete() {
    if (!folder_to_delete) return;
    set_submitting(true);
    set_operation_error(null);
    try {
      const requires_confirmation =
        folder_to_delete.recursive_asset_count > 0 ||
        has_descendants(folder_to_delete, folders);
      await delete_folder(
        folder_to_delete.folder_id,
        requires_confirmation ? folder_confirmation : null,
      );
      if (
        current_folder_id === folder_to_delete.folder_id ||
        folders.some(
          (folder) =>
            folder.folder_id === current_folder_id &&
            folder.materialized_path.startsWith(
              folder_to_delete.materialized_path,
            ),
        )
      ) {
        set_current_folder_id(null);
      }
      set_folder_to_delete(null);
      set_folder_confirmation("");
      clear_selection();
      await refresh_library();
    } catch (error) {
      set_operation_error(error_message(error));
    } finally {
      set_submitting(false);
    }
  }

  const context_folder =
    context_target !== "background" && context_target?.kind === "folder"
      ? (folders.find((folder) => folder.folder_id === context_target.id) ??
        null)
      : null;
  const context_asset =
    context_target !== "background" && context_target?.kind === "video"
      ? (assets.find((asset) => asset.asset_id === context_target.id) ?? null)
      : null;
  const delete_assets = assets.filter((asset) =>
    asset_ids_to_delete.includes(asset.asset_id),
  );
  const folder_requires_confirmation = Boolean(
    folder_to_delete &&
    (folder_to_delete.recursive_asset_count > 0 ||
      has_descendants(folder_to_delete, folders)),
  );

  return (
    <section
      className={cn(
        "flex min-h-0 min-w-0 flex-col gap-3 overflow-hidden",
        className,
      )}
      aria-label="视频库浏览器"
      data-compact={compact ? "true" : undefined}
      onKeyDown={handle_key_down}
    >
      {operation_error ? (
        <Alert variant="destructive" className="shrink-0">
          <AlertTitle>操作未完成</AlertTitle>
          <AlertDescription>{operation_error}</AlertDescription>
        </Alert>
      ) : null}

      <LibraryBrowserToolbar
        breadcrumbs={breadcrumbs}
        compact={compact}
        current_folder_id={current_folder_id}
        deferred_search={deferred_search}
        search={search}
        selected_asset_ids={selected_asset_ids}
        sort_value={sort_value}
        thumbnail_size={thumbnail_size}
        view_mode={view_mode}
        visible_item_count={visible_item_count}
        clear_selection={clear_selection}
        navigate_to_folder={navigate_to_folder}
        navigate_to_parent={navigate_to_parent}
        open_assets_move={open_assets_move}
        open_folder_editor={open_folder_editor}
        set_asset_ids_to_delete={set_asset_ids_to_delete}
        set_search={set_search}
        set_sort_value={set_sort_value}
        set_thumbnail_size={set_thumbnail_size}
        set_view_mode={set_view_mode}
      />

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="relative min-h-0 flex-1 overflow-auto rounded-xl outline-none select-none focus-visible:ring-2 focus-visible:ring-focus-subtle"
            role="region"
            aria-label="视频库项目"
            tabIndex={0}
            onPointerDown={handle_pointer_down}
            onPointerMove={handle_pointer_move}
            onPointerUp={finish_marquee_selection}
            onPointerCancel={finish_marquee_selection}
            onContextMenu={handle_context_menu}
          >
            <p className="sr-only" aria-live="polite">
              {selected_folder_id
                ? "已选择 1 个文件夹"
                : selected_asset_ids.size > 0
                  ? `已选择 ${selected_asset_ids.size} 个视频`
                  : "未选择项目"}
            </p>
            {loading ? (
              <LibraryBrowserSkeleton view_mode={view_mode} compact={compact} />
            ) : load_error ? (
              <Alert variant="destructive">
                <AlertTitle>无法加载视频库</AlertTitle>
                <AlertDescription>{error_message(load_error)}</AlertDescription>
              </Alert>
            ) : visible_item_count === 0 ? (
              <Empty className="h-full min-h-64 rounded-xl border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    {deferred_search ? <Search /> : <Library />}
                  </EmptyMedia>
                  <EmptyTitle>
                    {deferred_search ? "没有匹配的视频" : "这里还是空的"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {deferred_search
                      ? "搜索覆盖整个资料库，请尝试其他标题或作者。"
                      : "新建子文件夹，或从下载页面添加视频。"}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div
                className={cn(
                  "pb-2",
                  view_mode === "grid" ? "grid gap-3" : "flex flex-col gap-2",
                )}
                style={
                  view_mode === "grid"
                    ? ({
                        gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${thumbnail_size}px), 1fr))`,
                      } satisfies CSSProperties)
                    : undefined
                }
              >
                {direct_folders.map((folder) => (
                  <FolderItem
                    key={folder.folder_id}
                    folder={folder}
                    view_mode={view_mode}
                    selected={selected_folder_id === folder.folder_id}
                    drop_active={drop_folder_id === folder.folder_id}
                    on_click={select_folder}
                    on_focus={() =>
                      set_focused_item({
                        kind: "folder",
                        id: folder.folder_id,
                      })
                    }
                    on_open={navigate_to_folder}
                    on_drag_over={handle_folder_drag_over}
                    on_drag_leave={() => set_drop_folder_id(null)}
                    on_drop={handle_folder_drop}
                  />
                ))}
                {assets.map((asset) => (
                  <VideoItem
                    key={asset.asset_id}
                    asset={asset}
                    view_mode={view_mode}
                    compact={compact}
                    current={asset.asset_id === current_video_id}
                    selected={selected_asset_ids.has(asset.asset_id)}
                    dragging={dragging_asset_ids.includes(asset.asset_id)}
                    on_click={(event) =>
                      select_video(asset.asset_id, {
                        additive: event.ctrlKey || event.metaKey,
                        range: event.shiftKey,
                      })
                    }
                    on_focus={() =>
                      set_focused_item({ kind: "video", id: asset.asset_id })
                    }
                    on_open={() => void open_asset(asset)}
                    on_drag_start={(event) =>
                      handle_video_drag_start(event, asset)
                    }
                    on_drag_end={() => {
                      set_dragging_asset_ids([]);
                      set_drop_folder_id(null);
                    }}
                  />
                ))}
              </div>
            )}
            {selection_rectangle ? (
              <div
                className="pointer-events-none absolute rounded-sm border border-primary bg-primary-muted"
                style={selection_rectangle satisfies CSSProperties}
                aria-hidden="true"
              />
            ) : null}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>
            {context_folder?.name ??
              context_asset?.title ??
              (selected_asset_ids.size > 0
                ? `已选择 ${selected_asset_ids.size} 个视频`
                : "视频库")}
          </ContextMenuLabel>
          <ContextMenuSeparator />
          {context_folder ? (
            <ContextMenuGroup>
              <ContextMenuItem
                onSelect={() => navigate_to_folder(context_folder.folder_id)}
              >
                <FolderOpen />
                打开
                <ContextMenuShortcut>Enter</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() =>
                  open_folder_editor({
                    mode: "create",
                    folder: null,
                    parent_id: context_folder.folder_id,
                  })
                }
              >
                <FolderPlus />
                新建子文件夹
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() =>
                  open_folder_editor({
                    mode: "rename",
                    folder: context_folder,
                    parent_id: context_folder.parent_id,
                  })
                }
              >
                <Pencil />
                重命名
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() =>
                  set_move_target({ kind: "folder", folder: context_folder })
                }
              >
                <FolderInput />
                移动
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                onSelect={() => {
                  set_folder_to_delete(context_folder);
                  set_folder_confirmation("");
                }}
              >
                <Trash2 />
                永久删除
              </ContextMenuItem>
            </ContextMenuGroup>
          ) : context_asset ? (
            <ContextMenuGroup>
              <ContextMenuItem
                disabled={context_asset.status !== "ready"}
                onSelect={() => void open_asset(context_asset)}
              >
                <Play />
                打开视频
                <ContextMenuShortcut>Enter</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => open_assets_move([...selected_asset_ids])}
              >
                <FolderInput />
                移动所选
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                onSelect={() =>
                  set_asset_ids_to_delete([...selected_asset_ids])
                }
              >
                <Trash2 />
                删除所选
              </ContextMenuItem>
            </ContextMenuGroup>
          ) : (
            <ContextMenuGroup>
              <ContextMenuItem
                onSelect={() =>
                  open_folder_editor({
                    mode: "create",
                    folder: null,
                    parent_id: current_folder_id,
                  })
                }
              >
                <FolderPlus />
                新建文件夹
              </ContextMenuItem>
              <ContextMenuItem
                disabled={assets.length === 0}
                onSelect={select_all_videos}
              >
                <CheckSquare />
                {all_visible_videos_selected ? "取消全选" : "全选视频"}
                <ContextMenuShortcut>Ctrl+A</ContextMenuShortcut>
              </ContextMenuItem>
            </ContextMenuGroup>
          )}
        </ContextMenuContent>
      </ContextMenu>

      <LibraryBrowserDialogs
        folder_editor={folder_editor}
        folder_name={folder_name}
        move_target={move_target}
        folders={folders}
        asset_ids_to_delete={asset_ids_to_delete}
        delete_assets={delete_assets}
        folder_to_delete={folder_to_delete}
        folder_requires_confirmation={folder_requires_confirmation}
        folder_confirmation={folder_confirmation}
        submitting={submitting}
        set_folder_editor={set_folder_editor}
        set_folder_name={set_folder_name}
        set_move_target={set_move_target}
        set_asset_ids_to_delete={set_asset_ids_to_delete}
        set_folder_to_delete={set_folder_to_delete}
        set_folder_confirmation={set_folder_confirmation}
        submit_folder={submit_folder}
        submit_move={submit_move}
        confirm_asset_delete={confirm_asset_delete}
        confirm_folder_delete={confirm_folder_delete}
      />
    </section>
  );
}
