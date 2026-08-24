import { LibraryBig } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import { media_url } from "@/shared/api";
import { format_duration } from "@/shared/format";
import type { MediaAsset } from "@/shared/types";
import { CollapsiblePanelRail } from "./CollapsiblePanelRail";
import { WorkbenchPanelHeader } from "./WorkbenchPanelHeader";

type AssetLibraryProps = {
  assets: MediaAsset[];
  selected_asset_id: string | null;
  on_select: (asset_id: string) => void;
  collapsed?: boolean;
  on_collapsed_change?: (collapsed: boolean) => void;
};

export function AssetLibrary({
  assets,
  selected_asset_id,
  on_select,
  collapsed = false,
  on_collapsed_change,
}: AssetLibraryProps) {
  const ready_assets = assets.filter((asset) => asset.status === "ready");

  if (collapsed) {
    return (
      <aside
        className="h-full overflow-hidden bg-card"
        data-slot="asset-library"
        aria-label="视频库"
      >
        <CollapsiblePanelRail
          icon={LibraryBig}
          label="视频库"
          edge="left"
          on_expand={() => on_collapsed_change?.(false)}
        />
      </aside>
    );
  }

  return (
    <aside
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-r bg-card"
      data-slot="asset-library"
      aria-label="视频库"
    >
      <WorkbenchPanelHeader
        icon={LibraryBig}
        title="已下载视频"
        accessory={<Badge variant="secondary">{ready_assets.length}</Badge>}
        collapse_label="收起视频库"
        on_collapse={
          on_collapsed_change ? () => on_collapsed_change(true) : undefined
        }
      />
      {ready_assets.length === 0 ? (
        <Empty className="m-3 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LibraryBig aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>视频库为空</EmptyTitle>
            <EmptyDescription>下载完成的视频会显示在这里。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ol className="flex min-h-0 flex-col gap-1 overflow-y-auto p-2">
          {ready_assets.map((asset) => (
            <li key={asset.asset_id}>
              <button
                className={cn(
                  "grid w-full grid-cols-[5rem_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-transparent p-2 text-left transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  asset.asset_id === selected_asset_id &&
                    "border-primary/30 bg-primary/10",
                )}
                type="button"
                onClick={() => on_select(asset.asset_id)}
                aria-pressed={asset.asset_id === selected_asset_id}
              >
                <span className="grid aspect-video place-items-center overflow-hidden rounded-md bg-muted text-xs text-muted-foreground">
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
                <span className="min-w-0">
                  <strong className="block truncate text-xs font-medium">
                    {asset.title}
                  </strong>
                  <small className="mt-1 block truncate text-xs text-muted-foreground">
                    {asset.author_name ?? "未知作者"} ·{" "}
                    {format_duration(asset.duration_seconds)}
                  </small>
                </span>
                <span className="size-2 rounded-full bg-primary" title="就绪">
                  <span className="sr-only">就绪</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
