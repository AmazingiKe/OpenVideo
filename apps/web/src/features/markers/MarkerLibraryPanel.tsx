import { Library, PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LibraryBrowser } from "@/features/library/LibraryBrowser";
import { CollapsiblePanelRail } from "@/features/workbench/CollapsiblePanelRail";
import { cn } from "@/lib/utils";
import type { MediaAsset } from "@/shared/types";

type MarkerLibraryPanelProps = {
  collapsed?: boolean;
  compact?: boolean;
  current_video_id: string | null;
  initial_folder_id?: string | null;
  on_collapsed_change?: (collapsed: boolean) => void;
  on_open_video: (asset: MediaAsset) => void | Promise<void>;
};

export function MarkerLibraryPanel({
  collapsed = false,
  compact = false,
  current_video_id,
  initial_folder_id,
  on_collapsed_change,
  on_open_video,
}: MarkerLibraryPanelProps) {
  if (collapsed) {
    if (compact) {
      return (
        <aside
          className="flex h-12 shrink-0 items-center border-b bg-card px-2"
          aria-label="已收起的视频库"
          data-slot="marker-library-panel"
          data-collapsed="true"
        >
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => on_collapsed_change?.(false)}
          >
            <PanelLeftOpen data-icon="inline-start" aria-hidden="true" />
            打开视频库
          </Button>
        </aside>
      );
    }

    return (
      <aside
        className="h-full overflow-hidden bg-card"
        aria-label="已收起的视频库"
        data-slot="marker-library-panel"
        data-collapsed="true"
      >
        <CollapsiblePanelRail
          icon={Library}
          label="视频库"
          edge="left"
          on_expand={() => on_collapsed_change?.(false)}
        />
      </aside>
    );
  }

  return (
    <aside
      className={cn(
        "min-h-0 min-w-0 overflow-hidden bg-card",
        compact ? "h-[32rem] shrink-0 border-b" : "h-full",
      )}
      aria-label="视频库"
      data-slot="marker-library-panel"
      data-collapsed="false"
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b px-2">
          <div className="flex min-w-0 items-center gap-2 px-2 text-sm font-medium">
            <Library className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">视频库</span>
          </div>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={() => on_collapsed_change?.(true)}
            aria-label="收起视频库"
          >
            <PanelLeftClose aria-hidden="true" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 p-2">
          <LibraryBrowser
            className="h-full"
            current_video_id={current_video_id}
            initial_folder_id={initial_folder_id}
            compact
            on_open_video={on_open_video}
          />
        </div>
      </div>
    </aside>
  );
}
