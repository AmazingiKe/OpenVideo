import { type CSSProperties, type DragEvent, useState } from "react";
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
import { error_message } from "@/shared/errors";
import type { MediaAsset } from "@/shared/types";
import {
  FolderItem,
  LibraryBrowserSkeleton,
  VideoItem,
} from "./LibraryBrowserItems";
import { LibraryBrowserDialogs } from "./LibraryBrowserDialogs";
import { LibraryBrowserToolbar } from "./LibraryBrowserToolbar";
import { use_library_browser_data } from "./use_library_browser_data";
import { use_library_browser_mutations } from "./use_library_browser_mutations";
import { use_library_browser_selection } from "./use_library_browser_selection";

type LibraryBrowserProps = {
  current_video_id?: string | null;
  initial_folder_id?: string | null;
  compact?: boolean;
  className?: string;
  on_open_video: (asset: MediaAsset) => void | Promise<void>;
};

export function LibraryBrowser({
  current_video_id = null,
  initial_folder_id,
  compact = false,
  className,
  on_open_video,
}: LibraryBrowserProps) {
  const {
    assets,
    breadcrumbs,
    current_folder,
    current_folder_id,
    deferred_search,
    direct_folders,
    folders,
    load_error,
    loading,
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
    visible_item_count,
  } = use_library_browser_data(compact, initial_folder_id);
  const [operation_error, set_operation_error] = useState<string | null>(null);

  async function open_asset(asset: MediaAsset) {
    if (asset.status !== "ready") return;
    set_operation_error(null);
    try {
      await on_open_video(asset);
    } catch (error) {
      set_operation_error(error_message(error));
    }
  }

  const {
    all_visible_videos_selected,
    clear_selection,
    context_asset,
    context_folder,
    dragging_asset_ids,
    drop_folder_id,
    finish_marquee_selection,
    handle_context_menu,
    handle_folder_drag_over,
    handle_key_down,
    handle_pointer_down,
    handle_pointer_move,
    handle_video_drag_start,
    navigate_to_folder,
    navigate_to_parent,
    select_all_videos,
    select_folder,
    select_video,
    selected_asset_ids,
    selected_folder_id,
    selection_rectangle,
    set_dragging_asset_ids,
    set_drop_folder_id,
    set_focused_item,
  } = use_library_browser_selection({
    assets,
    current_folder,
    current_folder_id,
    deferred_search,
    folders,
    open_asset,
    set_current_folder_id,
  });

  const {
    asset_ids_to_delete,
    confirm_asset_delete,
    confirm_folder_delete,
    delete_assets,
    folder_confirmation,
    folder_editor,
    folder_name,
    folder_requires_confirmation,
    folder_to_delete,
    move_assets_to_folder,
    move_target,
    open_assets_move,
    open_folder_editor,
    set_asset_ids_to_delete,
    set_folder_confirmation,
    set_folder_editor,
    set_folder_name,
    set_folder_to_delete,
    set_move_target,
    submit_folder,
    submit_move,
    submitting,
  } = use_library_browser_mutations({
    assets,
    clear_selection,
    current_folder_id,
    folders,
    refresh_library,
    set_current_folder_id,
    set_operation_error,
  });

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
