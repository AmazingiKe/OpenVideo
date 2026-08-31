import { useCallback, useRef, useState } from "react";
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
import { LibraryBrowserSkeleton } from "./LibraryBrowserItems";
import { LibraryBrowserViewport } from "./LibraryBrowserViewport";
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
  const [scroll_element, set_scroll_element] = useState<HTMLDivElement | null>(
    null,
  );
  const scroll_element_ref = useRef<HTMLDivElement | null>(null);
  const set_scroll_element_ref = useCallback(
    (element: HTMLDivElement | null) => {
      scroll_element_ref.current = element;
      set_scroll_element(element);
    },
    [],
  );

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
    handle_context_menu,
    handle_key_down,
    navigate_to_folder,
    navigate_to_parent,
    replace_video_selection,
    select_all_videos,
    select_folder,
    select_video,
    selected_asset_ids,
    selected_folder_id,
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
            ref={set_scroll_element_ref}
            className="relative min-h-0 flex-1 overflow-auto overscroll-contain rounded-xl outline-none select-none focus-visible:ring-2 focus-visible:ring-focus-subtle"
            role="region"
            aria-label="视频库项目"
            tabIndex={0}
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
              <LibraryBrowserViewport
                assets={assets}
                compact={compact}
                current_video_id={current_video_id}
                direct_folders={direct_folders}
                scroll_element={scroll_element}
                scroll_element_ref={scroll_element_ref}
                selected_asset_ids={selected_asset_ids}
                selected_folder_id={selected_folder_id}
                thumbnail_size={thumbnail_size}
                view_mode={view_mode}
                move_assets_to_folder={move_assets_to_folder}
                navigate_to_folder={navigate_to_folder}
                open_asset={open_asset}
                replace_video_selection={replace_video_selection}
                select_folder={select_folder}
                select_video={select_video}
                set_focused_item={set_focused_item}
              />
            )}
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
