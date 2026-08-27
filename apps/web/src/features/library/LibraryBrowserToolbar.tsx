import {
  ArrowLeft,
  FolderInput,
  FolderPlus,
  Grid2X2,
  List,
  Maximize2,
  Search,
  Trash2,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type { LibraryFolder } from "@/shared/types";
import type { FolderEditor } from "./LibraryBrowserDialogs";
import { BreadcrumbFolder, type LibraryViewMode } from "./LibraryBrowserItems";

export type SortValue =
  "created_at_desc" | "created_at_asc" | "title_asc" | "duration_desc";

export const DEFAULT_THUMBNAIL_SIZE_PX = 208;

const THUMBNAIL_SIZE_MIN_PX = 144;
const THUMBNAIL_SIZE_MAX_PX = 320;
const THUMBNAIL_SIZE_STEP_PX = 16;

type LibraryBrowserToolbarProps = {
  breadcrumbs: LibraryFolder[];
  compact: boolean;
  current_folder_id: string | null;
  deferred_search: string;
  search: string;
  selected_asset_ids: Set<string>;
  sort_value: SortValue;
  thumbnail_size: number;
  view_mode: LibraryViewMode;
  visible_item_count: number;
  clear_selection: () => void;
  navigate_to_folder: (folder_id: string | null) => void;
  navigate_to_parent: () => void;
  open_assets_move: (asset_ids: string[]) => void;
  open_folder_editor: (editor: FolderEditor) => void;
  set_asset_ids_to_delete: (asset_ids: string[]) => void;
  set_search: (search: string) => void;
  set_sort_value: (sort_value: SortValue) => void;
  set_thumbnail_size: (thumbnail_size: number) => void;
  set_view_mode: (view_mode: LibraryViewMode) => void;
};

export function LibraryBrowserToolbar({
  breadcrumbs,
  compact,
  current_folder_id,
  deferred_search,
  search,
  selected_asset_ids,
  sort_value,
  thumbnail_size,
  view_mode,
  visible_item_count,
  clear_selection,
  navigate_to_folder,
  navigate_to_parent,
  open_assets_move,
  open_folder_editor,
  set_asset_ids_to_delete,
  set_search,
  set_sort_value,
  set_thumbnail_size,
  set_view_mode,
}: LibraryBrowserToolbarProps) {
  return (
    <>
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
        <Select value={sort_value} onValueChange={set_sort_value}>
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
    </>
  );
}
