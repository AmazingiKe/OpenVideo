import type { DragEvent, MouseEvent } from "react";
import { Check, CircleAlert, Clock3, Folder, Video } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  BreadcrumbItem,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { media_url } from "@/shared/api";
import { format_duration } from "@/shared/format";
import type { LibraryFolder, MediaAsset } from "@/shared/types";

export type LibraryViewMode = "grid" | "list";

const STATUS_LABELS: Record<MediaAsset["status"], string> = {
  pending: "等待中",
  downloading: "下载中",
  processing: "处理中",
  ready: "可用",
  failed: "失败",
};

export function BreadcrumbFolder({
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

export function FolderItem({
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

export function VideoItem({
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

export function LibraryBrowserSkeleton({
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
