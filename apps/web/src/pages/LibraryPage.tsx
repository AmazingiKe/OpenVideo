import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
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
  FolderPlus,
  Grid2X2,
  Library,
  List,
  Menu,
  Search,
  Trash2,
} from "lucide-react";
import { useNavigate } from "react-router-dom";

import { use_asset_catalog } from "@/app/asset_catalog";
import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import { PageHeader } from "@/components/PageHeader";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FolderTree, type LibraryScope } from "@/features/library/FolderTree";
import {
  LibraryVideoCard,
  type LibraryViewMode,
} from "@/features/library/LibraryVideoCard";
import { MoveToFolderDialog } from "@/features/library/MoveToFolderDialog";
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

type SortValue =
  "created_at_desc" | "created_at_asc" | "title_asc" | "duration_desc";
const EMPTY_FOLDERS: LibraryFolder[] = [];
const SORT_PARAMETERS: Record<
  SortValue,
  ["created_at" | "title" | "duration", "asc" | "desc"]
> = {
  created_at_desc: ["created_at", "desc"],
  created_at_asc: ["created_at", "asc"],
  title_asc: ["title", "asc"],
  duration_desc: ["duration", "desc"],
};
type FolderEditor = {
  mode: "create" | "rename";
  folder: LibraryFolder | null;
  parent_id: string | null;
};
type MoveTarget =
  | { kind: "assets"; asset_ids: string[]; initial_folder_id: string | null }
  | { kind: "folder"; folder: LibraryFolder }
  | null;
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

const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, [role="checkbox"], [role="menuitem"]';
const MARQUEE_DRAG_THRESHOLD = 3;

export function LibraryPage() {
  const navigate = useNavigate();
  const query_client = useQueryClient();
  const {
    assets: catalog_assets,
    refresh_assets,
    select_asset,
  } = use_asset_catalog();
  const [selected_scope, set_selected_scope] = useState<LibraryScope>("all");
  const [expanded_folder_ids, set_expanded_folder_ids] = useState<Set<string>>(
    new Set(),
  );
  const [search, set_search] = useState("");
  const deferred_search = useDeferredValue(search.trim());
  const [sort_value, set_sort_value] = useState<SortValue>("created_at_desc");
  const [view_mode, set_view_mode] = useState<LibraryViewMode>("grid");
  const [selected_asset_ids, set_selected_asset_ids] = useState<Set<string>>(
    new Set(),
  );
  const selection_anchor_id = useRef<string | null>(null);
  const marquee_gesture = useRef<MarqueeGesture | null>(null);
  const [selection_rectangle, set_selection_rectangle] =
    useState<SelectionRectangle | null>(null);
  const [mobile_tree_open, set_mobile_tree_open] = useState(false);
  const [folder_editor, set_folder_editor] = useState<FolderEditor | null>(
    null,
  );
  const [folder_name, set_folder_name] = useState("");
  const [move_target, set_move_target] = useState<MoveTarget>(null);
  const [asset_to_delete, set_asset_to_delete] = useState<MediaAsset | null>(
    null,
  );
  const [folder_to_delete, set_folder_to_delete] =
    useState<LibraryFolder | null>(null);
  const [folder_confirmation, set_folder_confirmation] = useState("");
  const [submitting, set_submitting] = useState(false);
  const [operation_error, set_operation_error] = useState<string | null>(null);

  const folders_query = useQuery({
    queryKey: RESOURCE_QUERY_KEYS.library_folders,
    queryFn: ({ signal }) => list_folders(signal),
  });
  const folders = folders_query.data ?? EMPTY_FOLDERS;
  const [sort_by, sort_order] = SORT_PARAMETERS[sort_value];
  const assets_query = useQuery({
    queryKey: [
      ...RESOURCE_QUERY_KEYS.assets,
      "library",
      selected_scope,
      deferred_search,
      sort_value,
    ],
    queryFn: ({ signal }) =>
      list_assets(signal, {
        folder_id:
          selected_scope === "all" || selected_scope === "uncategorized"
            ? undefined
            : selected_scope,
        uncategorized: selected_scope === "uncategorized",
        search: deferred_search || undefined,
        sort_by,
        sort_order,
      }),
  });
  const assets = assets_query.data ?? [];
  const uncategorized_count = catalog_assets.filter(
    (asset) => !asset.folder_id,
  ).length;
  const selected_folder = folders.find(
    (folder) => folder.folder_id === selected_scope,
  );
  const breadcrumb_folders = useMemo(
    () => folder_ancestors(selected_folder ?? null, folders),
    [folders, selected_folder],
  );
  const selected_visible_count = assets.filter((asset) =>
    selected_asset_ids.has(asset.asset_id),
  ).length;
  const all_visible_selected =
    assets.length > 0 && selected_visible_count === assets.length;

  useEffect(() => {
    if (!assets_query.data) return;
    const visible_asset_ids = new Set(
      assets_query.data.map((asset) => asset.asset_id),
    );
    set_selected_asset_ids((current) => {
      const visible_selection = new Set(
        [...current].filter((asset_id) => visible_asset_ids.has(asset_id)),
      );
      return visible_selection.size === current.size
        ? current
        : visible_selection;
    });
    if (
      selection_anchor_id.current &&
      !visible_asset_ids.has(selection_anchor_id.current)
    ) {
      selection_anchor_id.current = null;
    }
  }, [assets_query.data]);

  async function refresh_library() {
    await Promise.all([
      query_client.invalidateQueries({
        queryKey: RESOURCE_QUERY_KEYS.library_folders,
      }),
      query_client.invalidateQueries({ queryKey: RESOURCE_QUERY_KEYS.assets }),
      refresh_assets(),
    ]);
  }

  function select_scope(scope: LibraryScope) {
    set_selected_scope(scope);
    set_selected_asset_ids(new Set());
    selection_anchor_id.current = null;
    set_mobile_tree_open(false);
  }

  function select_all_visible_assets() {
    if (all_visible_selected) {
      set_selected_asset_ids(new Set());
      selection_anchor_id.current = null;
      return;
    }
    set_selected_asset_ids(new Set(assets.map((asset) => asset.asset_id)));
    selection_anchor_id.current = assets.at(-1)?.asset_id ?? null;
  }

  function select_asset_from_pointer(
    asset_id: string,
    options: { additive: boolean; range: boolean },
  ) {
    const visible_asset_ids = assets.map((asset) => asset.asset_id);
    const asset_index = visible_asset_ids.indexOf(asset_id);
    const anchor_index = selection_anchor_id.current
      ? visible_asset_ids.indexOf(selection_anchor_id.current)
      : -1;

    if (options.range && anchor_index >= 0 && asset_index >= 0) {
      const range_start = Math.min(anchor_index, asset_index);
      const range_end = Math.max(anchor_index, asset_index);
      const range_asset_ids = visible_asset_ids.slice(
        range_start,
        range_end + 1,
      );
      set_selected_asset_ids((current) => {
        const next = options.additive ? new Set(current) : new Set<string>();
        range_asset_ids.forEach((visible_asset_id) =>
          next.add(visible_asset_id),
        );
        return next;
      });
    } else if (options.additive) {
      set_selected_asset_ids((current) => {
        const next = new Set(current);
        if (next.has(asset_id)) next.delete(asset_id);
        else next.add(asset_id);
        return next;
      });
    } else {
      set_selected_asset_ids(new Set([asset_id]));
    }
    selection_anchor_id.current = asset_id;
  }

  function handle_selection_pointer_down(event: PointerEvent<HTMLDivElement>) {
    if (
      event.button !== 0 ||
      (event.pointerType && event.pointerType !== "mouse")
    ) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest(INTERACTIVE_SELECTOR)) return;

    event.currentTarget.focus({ preventScroll: true });
    const asset_card = target.closest<HTMLElement>("[data-library-asset-id]");
    if (asset_card) {
      const asset_id = asset_card.dataset.libraryAssetId;
      if (asset_id) {
        select_asset_from_pointer(asset_id, {
          additive: event.ctrlKey || event.metaKey,
          range: event.shiftKey,
        });
      }
      return;
    }

    event.preventDefault();
    const base_selection =
      event.ctrlKey || event.metaKey
        ? new Set(selected_asset_ids)
        : new Set<string>();
    marquee_gesture.current = {
      pointer_id: event.pointerId,
      start_x: event.clientX,
      start_y: event.clientY,
      base_selection,
    };
    set_selected_asset_ids(base_selection);
    selection_anchor_id.current = null;
    set_selection_rectangle(null);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handle_selection_pointer_move(event: PointerEvent<HTMLDivElement>) {
    const gesture = marquee_gesture.current;
    if (!gesture || gesture.pointer_id !== event.pointerId) return;
    const horizontal_distance = Math.abs(event.clientX - gesture.start_x);
    const vertical_distance = Math.abs(event.clientY - gesture.start_y);
    if (
      horizontal_distance < MARQUEE_DRAG_THRESHOLD &&
      vertical_distance < MARQUEE_DRAG_THRESHOLD
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
      .querySelectorAll<HTMLElement>("[data-library-asset-id]")
      .forEach((card) => {
        const asset_id = card.dataset.libraryAssetId;
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
    const gesture = marquee_gesture.current;
    if (!gesture || gesture.pointer_id !== event.pointerId) return;
    marquee_gesture.current = null;
    set_selection_rectangle(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handle_selection_key_down(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      select_all_visible_assets();
    } else if (event.key === "Escape") {
      set_selected_asset_ids(new Set());
      selection_anchor_id.current = null;
    }
  }

  function toggle_folder(folder_id: string) {
    set_expanded_folder_ids((current) => {
      const next = new Set(current);
      if (next.has(folder_id)) next.delete(folder_id);
      else next.add(folder_id);
      return next;
    });
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
          folder_name,
          folder_editor.parent_id,
        );
        if (folder_editor.parent_id) {
          set_expanded_folder_ids((current) =>
            new Set(current).add(folder_editor.parent_id as string),
          );
        }
        set_selected_scope(created.folder_id);
      } else if (folder_editor.folder) {
        await rename_folder(folder_editor.folder.folder_id, folder_name);
      }
      set_folder_editor(null);
      await refresh_library();
    } catch (error) {
      set_operation_error(error_message(error));
    } finally {
      set_submitting(false);
    }
  }

  async function submit_move(folder_id: string | null) {
    if (!move_target) return;
    set_submitting(true);
    set_operation_error(null);
    try {
      if (move_target.kind === "assets") {
        await move_assets(move_target.asset_ids, folder_id);
        set_selected_asset_ids(new Set());
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

  async function confirm_asset_delete() {
    if (!asset_to_delete) return;
    set_submitting(true);
    set_operation_error(null);
    try {
      await delete_asset(asset_to_delete.asset_id);
      set_selected_asset_ids((current) => {
        const next = new Set(current);
        next.delete(asset_to_delete.asset_id);
        return next;
      });
      set_asset_to_delete(null);
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
      await delete_folder(
        folder_to_delete.folder_id,
        folder_to_delete.recursive_asset_count > 0 ||
          has_descendants(folder_to_delete, folders)
          ? folder_confirmation
          : null,
      );
      if (
        selected_scope === folder_to_delete.folder_id ||
        folders.some(
          (folder) =>
            folder.folder_id === selected_scope &&
            folder.materialized_path.startsWith(
              folder_to_delete.materialized_path,
            ),
        )
      ) {
        set_selected_scope("all");
      }
      set_folder_to_delete(null);
      set_folder_confirmation("");
      await refresh_library();
    } catch (error) {
      set_operation_error(error_message(error));
    } finally {
      set_submitting(false);
    }
  }

  function open_workspace(asset: MediaAsset, path: "/markers" | "/summary") {
    select_asset(asset.asset_id);
    navigate(path);
  }

  const folder_tree = (
    <FolderTree
      folders={folders}
      selected_scope={selected_scope}
      expanded_folder_ids={expanded_folder_ids}
      uncategorized_count={uncategorized_count}
      on_select={select_scope}
      on_toggle={toggle_folder}
      on_create={(parent_id) =>
        open_folder_editor({ mode: "create", folder: null, parent_id })
      }
      on_rename={(folder) =>
        open_folder_editor({
          mode: "rename",
          folder,
          parent_id: folder.parent_id,
        })
      }
      on_move={(folder) => set_move_target({ kind: "folder", folder })}
      on_delete={(folder) => {
        set_folder_to_delete(folder);
        set_folder_confirmation("");
      }}
    />
  );

  return (
    <section
      className="mx-auto flex w-full max-w-screen-2xl flex-col gap-6 px-4 py-8 select-none md:px-8 md:py-10"
      aria-labelledby="library_page_title"
    >
      <PageHeader
        title_id="library_page_title"
        eyebrow="视频库"
        title="整理和查找所有视频"
        description="虚拟文件夹只改变分类，不会移动资料库中的真实文件。"
        icon={Library}
        action={
          <Badge variant="secondary">{catalog_assets.length} 个视频</Badge>
        }
      />
      {operation_error ? (
        <Alert variant="destructive">
          <AlertTitle>操作未完成</AlertTitle>
          <AlertDescription>{operation_error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid min-h-[32rem] gap-6 md:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="hidden rounded-xl border bg-card p-3 md:block">
          {folder_tree}
        </aside>
        <main
          className="relative flex min-w-0 flex-col gap-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          role="region"
          aria-label="视频选择区域"
          tabIndex={0}
          onPointerDown={handle_selection_pointer_down}
          onPointerMove={handle_selection_pointer_move}
          onPointerUp={finish_marquee_selection}
          onPointerCancel={finish_marquee_selection}
          onKeyDown={handle_selection_key_down}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="md:hidden"
              onClick={() => set_mobile_tree_open(true)}
            >
              <Menu data-icon="inline-start" />
              文件夹
            </Button>
            <Breadcrumb className="min-w-0 flex-1">
              <BreadcrumbList>
                <BreadcrumbItem>
                  <button type="button" onClick={() => select_scope("all")}>
                    全部视频
                  </button>
                </BreadcrumbItem>
                {selected_scope === "uncategorized" ? (
                  <>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <BreadcrumbPage>未分类</BreadcrumbPage>
                    </BreadcrumbItem>
                  </>
                ) : null}
                {breadcrumb_folders.map((folder) => (
                  <BreadcrumbPart
                    key={folder.folder_id}
                    folder={folder}
                    current={folder.folder_id === selected_scope}
                    on_select={select_scope}
                  />
                ))}
              </BreadcrumbList>
            </Breadcrumb>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                open_folder_editor({
                  mode: "create",
                  folder: null,
                  parent_id: selected_folder?.folder_id ?? null,
                })
              }
            >
              <FolderPlus data-icon="inline-start" />
              新建文件夹
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3">
            <div className="relative min-w-52 flex-1">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                className="pl-9 select-text"
                value={search}
                onChange={(event) => set_search(event.target.value)}
                placeholder="搜索标题或作者"
                aria-label="搜索视频"
              />
            </div>
            <Select
              value={sort_value}
              onValueChange={(value) => set_sort_value(value as SortValue)}
            >
              <SelectTrigger aria-label="视频排序">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectGroup>
                  <SelectItem value="created_at_desc">最新创建</SelectItem>
                  <SelectItem value="created_at_asc">最早创建</SelectItem>
                  <SelectItem value="title_asc">标题 A–Z</SelectItem>
                  <SelectItem value="duration_desc">时长从长到短</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <ToggleGroup
              type="single"
              value={view_mode}
              onValueChange={(value) => {
                if (value) set_view_mode(value as LibraryViewMode);
              }}
              aria-label="视频显示方式"
            >
              <ToggleGroupItem value="grid" aria-label="网格视图">
                <Grid2X2 />
              </ToggleGroupItem>
              <ToggleGroupItem value="list" aria-label="列表视图">
                <List />
              </ToggleGroupItem>
            </ToggleGroup>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={assets.length === 0}
              onClick={select_all_visible_assets}
            >
              <CheckSquare data-icon="inline-start" />
              {all_visible_selected ? "取消全选" : "全选当前结果"}
            </Button>
          </div>
          {selected_visible_count > 0 ? (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/50 p-3">
              <CheckSquare className="size-4" aria-hidden="true" />
              <p className="mr-auto text-sm">
                已选择 {selected_visible_count} 个视频
              </p>
              <Button
                type="button"
                size="sm"
                onClick={() =>
                  set_move_target({
                    kind: "assets",
                    asset_ids: assets
                      .filter((asset) => selected_asset_ids.has(asset.asset_id))
                      .map((asset) => asset.asset_id),
                    initial_folder_id: selected_folder?.folder_id ?? null,
                  })
                }
              >
                移动所选
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => set_selected_asset_ids(new Set())}
              >
                取消选择
              </Button>
            </div>
          ) : null}
          {assets_query.isLoading || folders_query.isLoading ? (
            <LibrarySkeleton view_mode={view_mode} />
          ) : assets_query.error || folders_query.error ? (
            <Alert variant="destructive">
              <AlertTitle>无法加载视频库</AlertTitle>
              <AlertDescription>
                {error_message(assets_query.error ?? folders_query.error)}
              </AlertDescription>
            </Alert>
          ) : assets.length === 0 ? (
            <Empty className="min-h-80 rounded-xl border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Library aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>这里还没有视频</EmptyTitle>
                <EmptyDescription>
                  {search
                    ? "没有匹配的标题或作者，换个关键词试试。"
                    : "前往下载页面添加视频，或切换到其他文件夹。"}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div
              className={cn(
                view_mode === "grid"
                  ? "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
                  : "flex flex-col gap-3",
              )}
            >
              {assets.map((asset) => (
                <LibraryVideoCard
                  key={asset.asset_id}
                  asset={asset}
                  selected={selected_asset_ids.has(asset.asset_id)}
                  view_mode={view_mode}
                  folder_name={
                    folders.find(
                      (folder) => folder.folder_id === asset.folder_id,
                    )?.name ?? "未分类"
                  }
                  on_selected_change={(selected) =>
                    set_selected_asset_ids((current) => {
                      const next = new Set(current);
                      if (selected) {
                        next.add(asset.asset_id);
                        selection_anchor_id.current = asset.asset_id;
                      } else {
                        next.delete(asset.asset_id);
                      }
                      return next;
                    })
                  }
                  on_move={() =>
                    set_move_target({
                      kind: "assets",
                      asset_ids: [asset.asset_id],
                      initial_folder_id: asset.folder_id ?? null,
                    })
                  }
                  on_delete={() => set_asset_to_delete(asset)}
                  on_open_markers={() => open_workspace(asset, "/markers")}
                  on_open_summary={() => open_workspace(asset, "/summary")}
                />
              ))}
              {selection_rectangle ? (
                <div
                  className="pointer-events-none absolute rounded-sm border border-primary bg-primary/10"
                  style={selection_rectangle satisfies CSSProperties}
                  aria-hidden="true"
                />
              ) : null}
            </div>
          )}
        </main>
      </div>

      <Sheet open={mobile_tree_open} onOpenChange={set_mobile_tree_open}>
        <SheetContent side="left">
          <SheetHeader>
            <SheetTitle>视频库文件夹</SheetTitle>
            <SheetDescription>选择当前要浏览的虚拟文件夹。</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">{folder_tree}</div>
        </SheetContent>
      </Sheet>

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
              <Field
                data-invalid={Boolean(operation_error)}
                data-disabled={submitting}
              >
                <FieldLabel htmlFor="folder_name">文件夹名称</FieldLabel>
                <Input
                  id="folder_name"
                  className="select-text"
                  value={folder_name}
                  onChange={(event) => set_folder_name(event.target.value)}
                  maxLength={100}
                  autoFocus
                  aria-invalid={Boolean(operation_error)}
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
        open={asset_to_delete !== null}
        onOpenChange={(open) => {
          if (!open && !submitting) set_asset_to_delete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Trash2 aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>永久删除视频？</AlertDialogTitle>
            <AlertDialogDescription>
              “{asset_to_delete?.title}”及其转录、标记和分析成果都会永久删除。
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
              <Trash2 aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>递归永久删除文件夹？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除 {folder_to_delete?.recursive_asset_count ?? 0}{" "}
              个视频及所有后代文件夹， 此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {folder_to_delete &&
          (folder_to_delete.recursive_asset_count > 0 ||
            has_descendants(folder_to_delete, folders)) ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="folder_delete_confirmation">
                  输入“{folder_to_delete.name}”确认
                </FieldLabel>
                <Input
                  id="folder_delete_confirmation"
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
                  (folder_to_delete.recursive_asset_count > 0 ||
                    has_descendants(folder_to_delete, folders)) &&
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

function BreadcrumbPart({
  folder,
  current,
  on_select,
}: {
  folder: LibraryFolder;
  current: boolean;
  on_select: (scope: LibraryScope) => void;
}) {
  return (
    <>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        {current ? (
          <BreadcrumbPage>{folder.name}</BreadcrumbPage>
        ) : (
          <button type="button" onClick={() => on_select(folder.folder_id)}>
            {folder.name}
          </button>
        )}
      </BreadcrumbItem>
    </>
  );
}

function LibrarySkeleton({ view_mode }: { view_mode: LibraryViewMode }) {
  return (
    <div
      className={cn(
        view_mode === "grid"
          ? "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
          : "flex flex-col gap-3",
      )}
      aria-label="正在加载视频"
    >
      {Array.from({ length: view_mode === "grid" ? 6 : 3 }, (_, index) => (
        <Skeleton key={index} className="h-64 rounded-xl" />
      ))}
    </div>
  );
}

function folder_ancestors(
  folder: LibraryFolder | null,
  folders: LibraryFolder[],
): LibraryFolder[] {
  if (!folder) return [];
  const by_id = new Map(
    folders.map((candidate) => [candidate.folder_id, candidate]),
  );
  const ancestors = [folder];
  let parent_id = folder.parent_id;
  while (parent_id) {
    const parent = by_id.get(parent_id);
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
) {
  return {
    left: Math.min(start_x, end_x),
    top: Math.min(start_y, end_y),
    right: Math.max(start_x, end_x),
    bottom: Math.max(start_y, end_y),
    width: Math.abs(end_x - start_x),
    height: Math.abs(end_y - start_y),
  };
}

function rectangles_intersect(
  first: Pick<DOMRect, "left" | "top" | "right" | "bottom">,
  second: Pick<DOMRect, "left" | "top" | "right" | "bottom">,
) {
  return (
    first.left <= second.right &&
    first.right >= second.left &&
    first.top <= second.bottom &&
    first.bottom >= second.top
  );
}
