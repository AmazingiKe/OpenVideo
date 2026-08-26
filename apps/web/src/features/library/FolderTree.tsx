import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Video,
} from "lucide-react";
import {
  type CSSProperties,
  type DragEvent,
  type ReactNode,
  useState,
} from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { LibraryFolder } from "@/shared/types";

export type LibraryScope = "all" | "uncategorized" | string;

type FolderTreeProps = {
  folders: LibraryFolder[];
  selected_scope: LibraryScope;
  expanded_folder_ids: Set<string>;
  uncategorized_count: number;
  on_select: (scope: LibraryScope) => void;
  on_toggle: (folder_id: string) => void;
  on_create: (parent_id: string | null) => void;
  on_rename: (folder: LibraryFolder) => void;
  on_move: (folder: LibraryFolder) => void;
  on_delete: (folder: LibraryFolder) => void;
  dragged_asset_count: number;
  on_assets_drop: (folder_id: string | null) => void;
};

export function FolderTree({
  folders,
  selected_scope,
  expanded_folder_ids,
  uncategorized_count,
  on_select,
  on_toggle,
  on_create,
  on_rename,
  on_move,
  on_delete,
  dragged_asset_count,
  on_assets_drop,
}: FolderTreeProps) {
  const total_count = folders.reduce(
    (count, folder) =>
      folder.parent_id === null ? count + folder.recursive_asset_count : count,
    uncategorized_count,
  );

  return (
    <nav className="flex flex-col gap-1" aria-label="视频库文件夹">
      <ScopeButton
        icon={Video}
        label="全部视频"
        count={total_count}
        selected={selected_scope === "all"}
        on_click={() => on_select("all")}
      />
      <FolderDropTarget
        target_folder_id={null}
        dragged_asset_count={dragged_asset_count}
        on_assets_drop={on_assets_drop}
      >
        {(drop_active) => (
          <ScopeButton
            icon={Folder}
            label="未分类"
            count={uncategorized_count}
            selected={selected_scope === "uncategorized"}
            drop_active={drop_active}
            on_click={() => on_select("uncategorized")}
          />
        )}
      </FolderDropTarget>
      <div className="mt-3 flex items-center justify-between px-2">
        <p className="text-xs font-medium text-muted-foreground">文件夹</p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="新建根文件夹"
          onClick={() => on_create(null)}
        >
          <FolderPlus />
        </Button>
      </div>
      <div role="tree" aria-label="嵌套文件夹">
        {folder_children(folders, null).map((folder) => (
          <FolderTreeItem
            key={folder.folder_id}
            folder={folder}
            folders={folders}
            depth={0}
            selected_scope={selected_scope}
            expanded_folder_ids={expanded_folder_ids}
            on_select={on_select}
            on_toggle={on_toggle}
            on_create={on_create}
            on_rename={on_rename}
            on_move={on_move}
            on_delete={on_delete}
            dragged_asset_count={dragged_asset_count}
            on_assets_drop={on_assets_drop}
          />
        ))}
      </div>
    </nav>
  );
}

function FolderTreeItem({
  folder,
  folders,
  depth,
  selected_scope,
  expanded_folder_ids,
  on_select,
  on_toggle,
  on_create,
  on_rename,
  on_move,
  on_delete,
  dragged_asset_count,
  on_assets_drop,
}: Omit<FolderTreeProps, "uncategorized_count"> & {
  folder: LibraryFolder;
  depth: number;
}) {
  const children = folder_children(folders, folder.folder_id);
  const is_expanded = expanded_folder_ids.has(folder.folder_id);
  const has_children = children.length > 0;

  return (
    <div role="treeitem" aria-expanded={has_children ? is_expanded : undefined}>
      <FolderDropTarget
        target_folder_id={folder.folder_id}
        dragged_asset_count={dragged_asset_count}
        on_assets_drop={on_assets_drop}
      >
        {(drop_active) => (
          <div
            className={cn(
              "group flex min-h-8 items-center rounded-lg [padding-inline-start:calc(var(--folder-depth)*var(--spacing)*4)] transition-colors hover:bg-muted",
              selected_scope === folder.folder_id && "bg-muted",
              drop_active && "bg-primary-muted ring-2 ring-primary-selected",
            )}
            style={{ "--folder-depth": depth } as CSSProperties}
          >
            {has_children ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={
                  is_expanded ? `收起 ${folder.name}` : `展开 ${folder.name}`
                }
                onClick={() => on_toggle(folder.folder_id)}
              >
                {is_expanded ? <ChevronDown /> : <ChevronRight />}
              </Button>
            ) : (
              <span className="size-7 shrink-0" aria-hidden="true" />
            )}
            <button
              type="button"
              aria-label={`${folder.name}，${folder.direct_asset_count} 个视频${drop_active ? `，释放以移动 ${dragged_asset_count} 个视频` : ""}`}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left text-sm focus-visible:ring-3 focus-visible:ring-focus-ring focus-visible:outline-none"
              onClick={() => on_select(folder.folder_id)}
            >
              <Folder
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="truncate">{folder.name}</span>
              <Badge className="ml-auto" variant="secondary">
                {folder.direct_asset_count}
              </Badge>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${folder.name} 操作`}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    onSelect={() => on_create(folder.folder_id)}
                  >
                    <FolderPlus />
                    新建子文件夹
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => on_rename(folder)}>
                    <Pencil />
                    重命名
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => on_move(folder)}>
                    <Folder />
                    移动
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => on_delete(folder)}
                  >
                    <Trash2 />
                    永久删除
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </FolderDropTarget>
      {has_children && is_expanded ? (
        <div role="group">
          {children.map((child) => (
            <FolderTreeItem
              key={child.folder_id}
              folder={child}
              folders={folders}
              depth={depth + 1}
              selected_scope={selected_scope}
              expanded_folder_ids={expanded_folder_ids}
              on_select={on_select}
              on_toggle={on_toggle}
              on_create={on_create}
              on_rename={on_rename}
              on_move={on_move}
              on_delete={on_delete}
              dragged_asset_count={dragged_asset_count}
              on_assets_drop={on_assets_drop}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ScopeButton({
  icon: ScopeIcon,
  label,
  count,
  selected,
  drop_active = false,
  on_click,
}: {
  icon: typeof Video;
  label: string;
  count: number;
  selected: boolean;
  drop_active?: boolean;
  on_click: () => void;
}) {
  return (
    <Button
      type="button"
      aria-label={`${label}，${count} 个视频`}
      variant={selected ? "secondary" : "ghost"}
      className={cn(
        "w-full justify-start",
        drop_active && "bg-primary-muted ring-2 ring-primary-selected",
      )}
      onClick={on_click}
    >
      <ScopeIcon data-icon="inline-start" />
      {label}
      <Badge className="ml-auto" variant="secondary">
        {count}
      </Badge>
    </Button>
  );
}

function FolderDropTarget({
  target_folder_id,
  dragged_asset_count,
  on_assets_drop,
  children,
}: {
  target_folder_id: string | null;
  dragged_asset_count: number;
  on_assets_drop: (folder_id: string | null) => void;
  children: (drop_active: boolean) => ReactNode;
}) {
  const [drop_active, set_drop_active] = useState(false);
  const enabled = dragged_asset_count > 0;

  function handle_drag_over(event: DragEvent<HTMLDivElement>) {
    if (!enabled) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    set_drop_active(true);
  }

  function handle_drag_leave(event: DragEvent<HTMLDivElement>) {
    const next_target = event.relatedTarget;
    if (
      next_target instanceof Node &&
      event.currentTarget.contains(next_target)
    ) {
      return;
    }
    set_drop_active(false);
  }

  function handle_drop(event: DragEvent<HTMLDivElement>) {
    if (!enabled) return;
    event.preventDefault();
    set_drop_active(false);
    on_assets_drop(target_folder_id);
  }

  return (
    <div
      onDragOver={handle_drag_over}
      onDragLeave={handle_drag_leave}
      onDrop={handle_drop}
    >
      {children(drop_active)}
    </div>
  );
}

export function folder_children(
  folders: LibraryFolder[],
  parent_id: string | null,
): LibraryFolder[] {
  return folders
    .filter((folder) => folder.parent_id === parent_id)
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}
