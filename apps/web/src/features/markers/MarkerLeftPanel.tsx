import type { ReactNode } from "react";
import { Bot, Library, PanelLeftClose } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LibraryBrowser } from "@/features/library/LibraryBrowser";
import { CollapsiblePanelRail } from "@/features/workbench/CollapsiblePanelRail";
import type { MarkersPageSettings, MediaAsset } from "@/shared/types";

type MarkerLeftPanelProps = {
  active_tab: MarkersPageSettings["left_panel_tab"];
  collapsed?: boolean;
  compact?: boolean;
  current_video_id: string | null;
  initial_folder_id?: string | null;
  agent_panel: ReactNode;
  on_active_tab_change: (tab: MarkersPageSettings["left_panel_tab"]) => void;
  on_collapsed_change?: (collapsed: boolean) => void;
  on_open_video: (asset: MediaAsset) => void | Promise<void>;
};

export function MarkerLeftPanel({
  active_tab,
  collapsed = false,
  compact = false,
  current_video_id,
  initial_folder_id,
  agent_panel,
  on_active_tab_change,
  on_collapsed_change,
  on_open_video,
}: MarkerLeftPanelProps) {
  if (collapsed && !compact) {
    return (
      <aside
        className="h-full overflow-hidden bg-card"
        aria-label="视频库与 Agent"
        data-slot="marker-left-panel"
      >
        <CollapsiblePanelRail
          icon={active_tab === "library" ? Library : Bot}
          label={active_tab === "library" ? "视频库" : "Agent"}
          edge="left"
          on_expand={() => on_collapsed_change?.(false)}
        />
      </aside>
    );
  }

  return (
    <aside
      className="h-full min-h-0 min-w-0 overflow-hidden bg-card"
      aria-label="视频库与 Agent"
      data-slot="marker-left-panel"
    >
      <Tabs
        value={active_tab}
        onValueChange={(value) =>
          on_active_tab_change(value as MarkersPageSettings["left_panel_tab"])
        }
        className="h-full min-h-0 gap-0"
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-b px-2">
          <TabsList className="w-full" aria-label="左侧面板">
            <TabsTrigger value="library">
              <Library data-icon="inline-start" />
              视频库
            </TabsTrigger>
            <TabsTrigger value="agent">
              <Bot data-icon="inline-start" />
              Agent
            </TabsTrigger>
          </TabsList>
          {!compact ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={() => on_collapsed_change?.(true)}
              aria-label="收起左侧面板"
            >
              <PanelLeftClose />
            </Button>
          ) : null}
        </header>
        <TabsContent
          value="library"
          forceMount
          className="min-h-0 overflow-hidden p-2 data-[state=inactive]:hidden"
        >
          <LibraryBrowser
            className="h-full"
            current_video_id={current_video_id}
            initial_folder_id={initial_folder_id}
            compact
            on_open_video={on_open_video}
          />
        </TabsContent>
        <TabsContent
          value="agent"
          forceMount
          className="min-h-0 overflow-hidden data-[state=inactive]:hidden"
        >
          {agent_panel}
        </TabsContent>
      </Tabs>
    </aside>
  );
}
