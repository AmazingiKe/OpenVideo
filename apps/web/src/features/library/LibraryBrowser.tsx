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
  ArrowLeft,
  Check,
  CheckSquare,
  CircleAlert,
  Clock3,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Grid2X2,
  Library,
  List,
  Maximize2,
  Pencil,
  Play,
  Search,
  Trash2,
  Video,
  X,
} from "lucide-react";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { MoveToFolderDialog } from "@/features/library/MoveToFolderDialog";
import { cn } from "@/lib/utils";
import {
  create_folder,
  delete_asset,
  delete_folder,
  list_assets,
  list_folders,
  media_url,
  move_assets,
  move_folder,
  rename_folder,
} from "@/shared/api";
import { error_message } from "@/shared/errors";
import { format_duration } from "@/shared/format";
import type { LibraryFolder, MediaAsset } from "@/shared/types";

export type LibraryViewMode = "grid" | "list";

type LibraryBrowserProps = {
  current_video_id?: string | null;
  initial_folder_id?: string | null;
  compact?: boolean;
  className?: string;
  on_open_video: (asset: MediaAsset) => void | Promise<void>;
};

type SortValue =
  "created_at_desc" | "created_at_asc" | "title_asc" | "duration_desc";

type FolderEditor = {
  mode: "create" | "rename";
  folder: LibraryFolder | null;
  parent_id: string | null;
};

type MoveTarget =
  | { kind: "assets"; asset_ids: string[]; initial_folder_id: string | null }
  | { kind: "folder"; folder: LibraryFolder }
  | null;

type FocusedItem =
  { kind: "folder"; id: string } | { kind: "video"; id: string } | null;

type ContextTarget = "background" | FocusedItem;

type SelectionRectangle = {
  left: number;
  top: number;
  width: number;
  height: number;
};

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
const THUMBNAIL_SIZE_MIN_PX = 144;
const THUMBNAIL_SIZE_MAX_PX = 320;
const THUMBNAIL_SIZE_STEP_PX = 16;
const DEFAULT_THUMBNAIL_SIZE_PX = 208;
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

const STATUS_LABELS: Record<MediaAsset["status"], string> = {
  pending: "等待中",
  downloading: "下载中",
  processing: "处理中",
  ready: "可用",
  failed: "失败",
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

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={current_folder_id === null || Boolean(deferred_search)}
          onClick={navigate_to_parent}
          aria-label="返回上级文件夹"
        >
          <ArrowLeft />
        </Button>
        <Breadcrumb className="min-w-0 flex-1 overflow-hidden">
          <BreadcrumbList className="flex-nowrap overflow-hidden">
            <BreadcrumbItem className="shrink-0">
              {current_folder_id === null && !deferred_search ? (
                <BreadcrumbPage>视频库</BreadcrumbPage>
              ) : (
                <button type="button" onClick={() => navigate_to_folder(null)}>
                  视频库
                </button>
              )}
            </BreadcrumbItem>
            {breadcrumbs.map((folder) => (
              <BreadcrumbFolder
                key={folder.folder_id}
                folder={folder}
                current={
                  folder.folder_id === current_folder_id && !deferred_search
                }
                on_select={navigate_to_folder}
              />
            ))}
            {deferred_search ? (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>搜索结果</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            ) : null}
          </BreadcrumbList>
        </Breadcrumb>
        <Button
          type="button"
          size={compact ? "icon-sm" : "sm"}
          variant="outline"
          onClick={() =>
            open_folder_editor({
              mode: "create",
              folder: null,
              parent_id: current_folder_id,
            })
          }
          aria-label="新建文件夹"
        >
          <FolderPlus data-icon={compact ? undefined : "inline-start"} />
          {compact ? null : "新建文件夹"}
        </Button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border bg-card p-2">
        <div className="relative min-w-40 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            className="pl-9 select-text"
            value={search}
            onChange={(event) => {
              set_search(event.target.value);
              clear_selection();
            }}
            placeholder="搜索全部视频"
            aria-label="搜索全部视频"
          />
        </div>
        <Select
          value={sort_value}
          onValueChange={(value) => set_sort_value(value as SortValue)}
        >
          <SelectTrigger
            size="sm"
            className={cn(compact ? "w-28" : "w-32")}
            aria-label="项目排序"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectGroup>
              <SelectItem value="created_at_desc">最新创建</SelectItem>
              <SelectItem value="created_at_asc">最早创建</SelectItem>
              <SelectItem value="title_asc">标题 A–Z</SelectItem>
              <SelectItem value="duration_desc">时长降序</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <ToggleGroup
          type="single"
          value={view_mode}
          onValueChange={(value) => {
            if (value) set_view_mode(value as LibraryViewMode);
          }}
          aria-label="项目显示方式"
        >
          <ToggleGroupItem value="grid" aria-label="网格视图">
            <Grid2X2 />
          </ToggleGroupItem>
          <ToggleGroupItem value="list" aria-label="列表视图">
            <List />
          </ToggleGroupItem>
        </ToggleGroup>
        {view_mode === "grid" ? (
          <div className="flex min-w-28 flex-1 items-center gap-2 sm:max-w-40">
            <Maximize2 className="size-4 shrink-0 text-muted-foreground" />
            <Slider
              value={[thumbnail_size]}
              min={THUMBNAIL_SIZE_MIN_PX}
              max={THUMBNAIL_SIZE_MAX_PX}
              step={THUMBNAIL_SIZE_STEP_PX}
              onValueChange={(value) =>
                set_thumbnail_size(value[0] ?? DEFAULT_THUMBNAIL_SIZE_PX)
              }
              aria-label="缩略图尺寸"
            />
          </div>
        ) : null}
        <Badge variant="secondary">{visible_item_count} 项</Badge>
      </div>

      {selected_asset_ids.size > 1 ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border bg-card px-3 py-2">
          <span className="mr-auto text-sm text-muted-foreground">
            已选择 {selected_asset_ids.size} 个视频
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => open_assets_move([...selected_asset_ids])}
          >
            <FolderInput data-icon="inline-start" />
            移动
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => set_asset_ids_to_delete([...selected_asset_ids])}
          >
            <Trash2 data-icon="inline-start" />
            删除
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={clear_selection}
            aria-label="取消选择"
          >
            <X />
          </Button>
        </div>
      ) : null}

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

      <Dialog
        open={folder_editor !== null}
        onOpenChange={(open) => {
          if (!open && !submitting) set_folder_editor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {folder_editor?.mode === "rename" ? "重命名文件夹" : "新建文件夹"}
            </DialogTitle>
            <DialogDescription>
              文件夹只用于整理视频，不会创建或移动真实目录。
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={submit_folder}>
            <FieldGroup>
              <Field data-disabled={submitting}>
                <FieldLabel htmlFor="library_folder_name">
                  文件夹名称
                </FieldLabel>
                <Input
                  id="library_folder_name"
                  className="select-text"
                  value={folder_name}
                  onChange={(event) => set_folder_name(event.target.value)}
                  maxLength={100}
                  autoFocus
                  disabled={submitting}
                />
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={submitting}
                onClick={() => set_folder_editor(null)}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={submitting || !folder_name.trim()}
              >
                {submitting ? <Spinner data-icon="inline-start" /> : null}
                保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <MoveToFolderDialog
        open={move_target !== null}
        title={move_target?.kind === "folder" ? "移动文件夹" : "移动视频"}
        description={
          move_target?.kind === "folder"
            ? "选择新的父文件夹，所有后代会保持原有层级。"
            : `将 ${move_target?.asset_ids.length ?? 0} 个视频归入同一文件夹。`
        }
        folders={folders}
        initial_folder_id={
          move_target?.kind === "folder"
            ? move_target.folder.parent_id
            : (move_target?.initial_folder_id ?? null)
        }
        excluded_folder_ids={
          move_target?.kind === "folder"
            ? new Set(
                folders
                  .filter((folder) =>
                    folder.materialized_path.startsWith(
                      move_target.folder.materialized_path,
                    ),
                  )
                  .map((folder) => folder.folder_id),
              )
            : new Set()
        }
        root_label={move_target?.kind === "folder" ? "根目录" : "未分类"}
        submitting={submitting}
        on_open_change={(open) => {
          if (!open && !submitting) set_move_target(null);
        }}
        on_submit={(folder_id) => void submit_move(folder_id)}
      />

      <AlertDialog
        open={asset_ids_to_delete.length > 0}
        onOpenChange={(open) => {
          if (!open && !submitting) set_asset_ids_to_delete([]);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Trash2 />
            </AlertDialogMedia>
            <AlertDialogTitle>
              永久删除 {asset_ids_to_delete.length} 个视频？
            </AlertDialogTitle>
            <AlertDialogDescription>
              {delete_assets.length === 1
                ? `“${delete_assets[0]?.title}”及其转录、标记和分析成果都会永久删除。`
                : "所选视频及其转录、标记和分析成果都会永久删除。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={submitting}
              onClick={(event) => {
                event.preventDefault();
                void confirm_asset_delete();
              }}
            >
              {submitting ? <Spinner data-icon="inline-start" /> : null}
              永久删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={folder_to_delete !== null}
        onOpenChange={(open) => {
          if (!open && !submitting) set_folder_to_delete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Trash2 />
            </AlertDialogMedia>
            <AlertDialogTitle>递归永久删除文件夹？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除 {folder_to_delete?.recursive_asset_count ?? 0}{" "}
              个视频及所有后代文件夹，此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {folder_to_delete && folder_requires_confirmation ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="library_folder_delete_confirmation">
                  输入“{folder_to_delete.name}”确认
                </FieldLabel>
                <Input
                  id="library_folder_delete_confirmation"
                  className="select-text"
                  value={folder_confirmation}
                  onChange={(event) =>
                    set_folder_confirmation(event.target.value)
                  }
                  disabled={submitting}
                />
              </Field>
            </FieldGroup>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={
                submitting ||
                Boolean(
                  folder_to_delete &&
                  folder_requires_confirmation &&
                  folder_confirmation !== folder_to_delete.name,
                )
              }
              onClick={(event) => {
                event.preventDefault();
                void confirm_folder_delete();
              }}
            >
              {submitting ? <Spinner data-icon="inline-start" /> : null}
              递归永久删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function BreadcrumbFolder({
  folder,
  current,
  on_select,
}: {
  folder: LibraryFolder;
  current: boolean;
  on_select: (folder_id: string) => void;
}) {
  return (
    <>
      <BreadcrumbSeparator />
      <BreadcrumbItem className="min-w-0">
        {current ? (
          <BreadcrumbPage className="truncate">{folder.name}</BreadcrumbPage>
        ) : (
          <button
            type="button"
            className="truncate"
            onClick={() => on_select(folder.folder_id)}
          >
            {folder.name}
          </button>
        )}
      </BreadcrumbItem>
    </>
  );
}

function FolderItem({
  folder,
  view_mode,
  selected,
  drop_active,
  on_click,
  on_focus,
  on_open,
  on_drag_over,
  on_drag_leave,
  on_drop,
}: {
  folder: LibraryFolder;
  view_mode: LibraryViewMode;
  selected: boolean;
  drop_active: boolean;
  on_click: (folder_id: string) => void;
  on_focus: () => void;
  on_open: (folder_id: string) => void;
  on_drag_over: (
    event: DragEvent<HTMLButtonElement>,
    folder_id: string,
  ) => void;
  on_drag_leave: () => void;
  on_drop: (event: DragEvent<HTMLButtonElement>, folder_id: string) => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "group min-w-0 rounded-xl border bg-card text-left transition-[border-color,box-shadow,background-color] hover:bg-muted focus-visible:ring-3 focus-visible:ring-focus-ring focus-visible:outline-none",
        selected && "border-primary ring-2 ring-primary-selected",
        drop_active && "bg-primary-muted ring-2 ring-primary-selected",
        view_mode === "grid"
          ? "flex min-h-28 flex-col justify-between gap-4 p-4"
          : "flex min-h-16 items-center gap-3 p-3",
      )}
      aria-label={`${folder.name}，${folder.recursive_asset_count} 个视频`}
      aria-pressed={selected}
      data-library-item="true"
      data-library-kind="folder"
      data-library-id={folder.folder_id}
      onClick={() => on_click(folder.folder_id)}
      onFocus={on_focus}
      onDoubleClick={() => on_open(folder.folder_id)}
      onDragOver={(event) => on_drag_over(event, folder.folder_id)}
      onDragLeave={on_drag_leave}
      onDrop={(event) => void on_drop(event, folder.folder_id)}
    >
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground",
          view_mode === "grid" ? "size-12" : "size-10",
        )}
      >
        <Folder className={view_mode === "grid" ? "size-7" : "size-5"} />
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block truncate text-sm font-medium">
          {folder.name}
        </strong>
        <span className="block text-xs text-muted-foreground">
          {folder.recursive_asset_count} 个视频
        </span>
      </span>
      {selected ? <Check className="size-4 shrink-0 text-primary" /> : null}
    </button>
  );
}

function VideoItem({
  asset,
  view_mode,
  compact,
  current,
  selected,
  dragging,
  on_click,
  on_focus,
  on_open,
  on_drag_start,
  on_drag_end,
}: {
  asset: MediaAsset;
  view_mode: LibraryViewMode;
  compact: boolean;
  current: boolean;
  selected: boolean;
  dragging: boolean;
  on_click: (event: MouseEvent<HTMLButtonElement>) => void;
  on_focus: () => void;
  on_open: () => void;
  on_drag_start: (event: DragEvent<HTMLButtonElement>) => void;
  on_drag_end: () => void;
}) {
  const status_variant =
    asset.status === "failed" ? "destructive" : "secondary";
  return (
    <button
      type="button"
      className={cn(
        "group min-w-0 overflow-hidden rounded-xl border bg-card text-left transition-[border-color,box-shadow,opacity] hover:border-primary focus-visible:ring-3 focus-visible:ring-focus-ring focus-visible:outline-none",
        selected && "border-primary ring-2 ring-primary-selected",
        dragging && "opacity-60",
        view_mode === "list" && "flex min-h-20 items-center",
      )}
      aria-label={`${asset.title}，${STATUS_LABELS[asset.status]}${current ? "，当前视频" : ""}`}
      aria-pressed={selected}
      aria-disabled={asset.status !== "ready"}
      data-library-item="true"
      data-library-kind="video"
      data-library-id={asset.asset_id}
      draggable
      onClick={on_click}
      onFocus={on_focus}
      onDoubleClick={on_open}
      onDragStart={on_drag_start}
      onDragEnd={on_drag_end}
    >
      <span
        className={cn(
          "relative grid shrink-0 place-items-center overflow-hidden bg-muted text-muted-foreground",
          view_mode === "grid" ? "aspect-video w-full" : "aspect-video h-20",
          compact && view_mode === "list" && "h-16",
        )}
      >
        {asset.thumbnail_url ? (
          <img
            className="size-full object-cover"
            src={media_url(asset.thumbnail_url)}
            alt=""
            loading="lazy"
          />
        ) : (
          <Video className="size-8" />
        )}
        <Badge className="absolute right-2 bottom-2" variant="secondary">
          {format_duration(asset.duration_seconds)}
        </Badge>
        {selected ? (
          <span className="absolute top-2 left-2 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check className="size-4" />
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-2 p-3",
          view_mode === "grid" && "pt-3",
        )}
      >
        <span className="flex min-w-0 items-start gap-2">
          <strong className="line-clamp-2 min-w-0 flex-1 text-sm font-medium">
            {asset.title}
          </strong>
          {current ? <Badge variant="default">当前</Badge> : null}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={status_variant}>{STATUS_LABELS[asset.status]}</Badge>
          <span className="truncate">{asset.author_name ?? "未知作者"}</span>
          {view_mode === "list" && !compact ? (
            <span className="flex items-center gap-1">
              <Clock3 className="size-3" />
              <time dateTime={asset.created_at}>
                {new Intl.DateTimeFormat("zh-CN", {
                  dateStyle: "medium",
                }).format(new Date(asset.created_at))}
              </time>
            </span>
          ) : null}
        </span>
        {asset.status !== "ready" ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <CircleAlert className="size-3" />
            {asset.status === "failed"
              ? (asset.error_message ?? "处理失败，仍可移动或删除。")
              : "处理完成后才能打开。"}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function LibraryBrowserSkeleton({
  view_mode,
  compact,
}: {
  view_mode: LibraryViewMode;
  compact: boolean;
}) {
  const item_count = compact ? 4 : 8;
  return (
    <div
      className={cn(
        view_mode === "grid"
          ? "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
          : "flex flex-col gap-2",
      )}
      role="status"
      aria-label="正在加载视频库"
    >
      {Array.from({ length: item_count }, (_, index) => (
        <Skeleton
          key={index}
          className={cn(view_mode === "grid" ? "h-52" : "h-20")}
        />
      ))}
    </div>
  );
}

function folder_ancestors(
  folder: LibraryFolder | null,
  folders: LibraryFolder[],
): LibraryFolder[] {
  if (!folder) return [];
  const folders_by_id = new Map(
    folders.map((candidate) => [candidate.folder_id, candidate]),
  );
  const ancestors = [folder];
  let parent_id = folder.parent_id;
  while (parent_id) {
    const parent = folders_by_id.get(parent_id);
    if (!parent) break;
    ancestors.unshift(parent);
    parent_id = parent.parent_id;
  }
  return ancestors;
}

function has_descendants(
  folder: LibraryFolder,
  folders: LibraryFolder[],
): boolean {
  return folders.some(
    (candidate) =>
      candidate.folder_id !== folder.folder_id &&
      candidate.materialized_path.startsWith(folder.materialized_path),
  );
}

function normalized_rectangle(
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

function rectangles_intersect(
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
