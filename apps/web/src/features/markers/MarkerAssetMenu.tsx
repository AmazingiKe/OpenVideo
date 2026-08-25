import { useMemo, useState } from "react";
import { Check, ChevronDown, Search, Video } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { media_url } from "@/shared/api";
import { format_duration } from "@/shared/format";
import type { MediaAsset } from "@/shared/types";

type MarkerAssetMenuProps = {
  assets: MediaAsset[];
  selected_asset_id: string | null;
  on_select: (asset_id: string) => void;
};

export function MarkerAssetMenu({
  assets,
  selected_asset_id,
  on_select,
}: MarkerAssetMenuProps) {
  const [open, set_open] = useState(false);
  const [query, set_query] = useState("");
  const ready_assets = useMemo(
    () =>
      assets
        .filter((asset) => asset.status === "ready")
        .sort((first, second) =>
          second.created_at.localeCompare(first.created_at),
        ),
    [assets],
  );
  const selected_asset = ready_assets.find(
    (asset) => asset.asset_id === selected_asset_id,
  );
  const normalized_query = query.trim().toLocaleLowerCase();
  const filtered_assets = ready_assets.filter((asset) => {
    if (!normalized_query) return true;
    return [asset.title, asset.author_name]
      .filter((value): value is string => value !== null)
      .some((value) => value.toLocaleLowerCase().includes(normalized_query));
  });

  function change_open(next_open: boolean) {
    set_open(next_open);
    if (next_open) set_query("");
  }

  function select_asset(asset_id: string) {
    on_select(asset_id);
    set_open(false);
  }

  return (
    <Popover open={open} onOpenChange={change_open}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="max-w-36 justify-between sm:max-w-56 sm:min-w-44"
          aria-label="选择标记视频"
        >
          <Video data-icon="inline-start" aria-hidden="true" />
          <span className="truncate">
            {selected_asset?.title ?? "选择视频"}
          </span>
          <ChevronDown data-icon="inline-end" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 max-w-[calc(100vw-1rem)] gap-0 p-0"
      >
        <div className="p-2">
          <label className="sr-only" htmlFor="marker-asset-search">
            搜索视频
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="marker-asset-search"
              value={query}
              onChange={(event) => set_query(event.target.value)}
              placeholder="搜索标题或作者"
              className="pl-8"
              autoFocus
            />
          </div>
        </div>
        <Separator />
        <p className="px-3 py-2 text-xs font-medium text-muted-foreground">
          已下载视频
        </p>
        {filtered_assets.length === 0 ? (
          <Empty className="p-4">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Video aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>
                {ready_assets.length === 0 ? "暂无可用视频" : "没有匹配的视频"}
              </EmptyTitle>
              <EmptyDescription>
                {ready_assets.length === 0
                  ? "下载完成的视频会显示在这里。"
                  : "请尝试其他标题或作者。"}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto p-1">
            {filtered_assets.map((asset) => {
              const is_selected = asset.asset_id === selected_asset_id;
              return (
                <li key={asset.asset_id}>
                  <Button
                    type="button"
                    variant={is_selected ? "secondary" : "ghost"}
                    className="h-auto w-full justify-start px-2 py-2"
                    onClick={() => select_asset(asset.asset_id)}
                    aria-current={is_selected ? "true" : undefined}
                  >
                    <span className="grid aspect-video w-16 shrink-0 place-items-center overflow-hidden rounded-md bg-muted text-xs text-muted-foreground">
                      {asset.thumbnail_url ? (
                        <img
                          className="size-full object-cover"
                          src={media_url(asset.thumbnail_url)}
                          alt=""
                        />
                      ) : (
                        "OV"
                      )}
                    </span>
                    <span className="min-w-0 flex-1 text-left">
                      <span className="block truncate">{asset.title}</span>
                      <span className="block truncate text-xs font-normal text-muted-foreground">
                        {asset.author_name ?? "未知作者"} ·{" "}
                        {format_duration(asset.duration_seconds)}
                      </span>
                    </span>
                    {is_selected ? <Check aria-label="当前视频" /> : null}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
