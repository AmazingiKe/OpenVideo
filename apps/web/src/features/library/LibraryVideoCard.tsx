import {
  Clock3,
  FileText,
  Flag,
  FolderInput,
  MoreHorizontal,
  Trash2,
  Video,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { format_duration } from "@/shared/format";
import type { MediaAsset } from "@/shared/types";

export type LibraryViewMode = "grid" | "list";

type LibraryVideoCardProps = {
  asset: MediaAsset;
  selected: boolean;
  view_mode: LibraryViewMode;
  folder_name: string;
  on_selected_change: (selected: boolean) => void;
  on_move: () => void;
  on_delete: () => void;
  on_open_markers: () => void;
  on_open_summary: () => void;
};

export function LibraryVideoCard({
  asset,
  selected,
  view_mode,
  folder_name,
  on_selected_change,
  on_move,
  on_delete,
  on_open_markers,
  on_open_summary,
}: LibraryVideoCardProps) {
  return (
    <Card
      size="sm"
      className={cn(
        "transition-shadow focus-within:ring-2 focus-within:ring-ring/40",
        selected && "ring-2 ring-primary/40",
        view_mode === "list" &&
          "sm:grid sm:grid-cols-[12rem_minmax(0,1fr)_auto] sm:items-center",
      )}
      aria-label={asset.title}
    >
      <div
        className={cn(
          "relative aspect-video overflow-hidden bg-muted",
          view_mode === "list" &&
            "sm:row-span-3 sm:aspect-video sm:self-stretch",
        )}
      >
        {asset.thumbnail_url ? (
          <img
            className="size-full object-cover"
            src={asset.thumbnail_url}
            alt=""
            loading="lazy"
          />
        ) : (
          <span className="flex size-full items-center justify-center text-muted-foreground">
            <Video className="size-8" aria-hidden="true" />
          </span>
        )}
        <div className="absolute top-2 left-2">
          <Checkbox
            checked={selected}
            onCheckedChange={(checked) => on_selected_change(checked === true)}
            aria-label={`选择 ${asset.title}`}
          />
        </div>
        <Badge className="absolute right-2 bottom-2" variant="secondary">
          {format_duration(asset.duration_seconds)}
        </Badge>
      </div>
      <CardHeader className={cn(view_mode === "list" && "sm:col-start-2")}>
        <CardTitle className="line-clamp-2">{asset.title}</CardTitle>
        <CardDescription className="truncate">
          {asset.author_name ?? "未知作者"}
        </CardDescription>
        <CardAction>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`${asset.title} 操作`}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={on_move}>
                  <FolderInput />
                  移动到文件夹
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={on_open_markers}>
                  <Flag />
                  进入标记
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={on_open_summary}>
                  <FileText />
                  进入解析
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={on_delete}>
                  <Trash2 />
                  永久删除
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>
      <CardContent
        className={cn(
          "flex items-center gap-2 text-xs text-muted-foreground",
          view_mode === "list" && "sm:col-start-2",
        )}
      >
        <Clock3 className="size-3.5" aria-hidden="true" />
        <time dateTime={asset.created_at}>
          {new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(
            new Date(asset.created_at),
          )}
        </time>
      </CardContent>
      <CardFooter
        className={cn(
          "justify-between gap-2",
          view_mode === "list" &&
            "sm:col-start-3 sm:row-span-3 sm:row-start-1 sm:h-full sm:flex-col sm:justify-center sm:border-t-0 sm:border-l",
        )}
      >
        <Badge variant="outline">{folder_name}</Badge>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={on_open_markers}
        >
          <Flag data-icon="inline-start" />
          标记
        </Button>
      </CardFooter>
    </Card>
  );
}
