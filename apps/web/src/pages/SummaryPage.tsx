import { useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

import { use_asset_catalog } from "@/app/asset_catalog";
import { use_local_preferences } from "@/app/local_preferences";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { FloatingError } from "@/components/FloatingError";
import { use_asset_analysis } from "@/features/analysis/use_asset_analysis";
import { SummaryMediaShelf } from "@/features/summary/SummaryMediaShelf";
import { SummaryWorkspace } from "@/features/workbench/SummaryWorkspace";
import { cn } from "@/lib/utils";

const SUMMARY_MEDIA_COLLAPSED_HEIGHT_PX = 48;
const SUMMARY_MEDIA_DEFAULT_HEIGHT_PX = 264;
const SUMMARY_MEDIA_MIN_HEIGHT_PX = 200;
const SUMMARY_MEDIA_MAX_HEIGHT_PX = 360;
const SUMMARY_EDITOR_MIN_HEIGHT_PX = 320;

export function SummaryPage() {
  const { selected_asset, selected_asset_id } = use_asset_catalog();
  const { preferences, set_summary_media_expanded } = use_local_preferences();
  const { transcript, analysis_error } = use_asset_analysis(selected_asset_id);
  const [page_error, set_page_error] = useState<string | null>(null);
  const media_panel_ref = useRef<PanelImperativeHandle>(null);
  const media_available = Boolean(selected_asset?.playback_url);
  const media_expanded =
    media_available && (preferences.summary_media_expanded ?? false);
  const error = page_error ?? analysis_error;

  useEffect(() => {
    if (media_expanded) {
      media_panel_ref.current?.resize(`${SUMMARY_MEDIA_DEFAULT_HEIGHT_PX}px`);
    } else {
      media_panel_ref.current?.collapse();
    }
  }, [media_expanded]);

  function change_media_expanded(expanded: boolean) {
    set_summary_media_expanded(expanded);
  }

  return (
    <>
      <ResizablePanelGroup
        id="summary-media-workspace"
        orientation="vertical"
        className="h-full min-h-0 min-w-0"
      >
        <ResizablePanel
          id="summary-media"
          panelRef={media_panel_ref}
          defaultSize={
            media_expanded
              ? `${SUMMARY_MEDIA_DEFAULT_HEIGHT_PX}px`
              : `${SUMMARY_MEDIA_COLLAPSED_HEIGHT_PX}px`
          }
          minSize={`${SUMMARY_MEDIA_MIN_HEIGHT_PX}px`}
          maxSize={`${SUMMARY_MEDIA_MAX_HEIGHT_PX}px`}
          collapsedSize={`${SUMMARY_MEDIA_COLLAPSED_HEIGHT_PX}px`}
          collapsible
          className="min-h-0 overflow-hidden"
        >
          <SummaryMediaShelf
            asset={selected_asset}
            expanded={media_expanded}
            on_expanded_change={change_media_expanded}
            transcript={transcript}
          />
        </ResizablePanel>
        <ResizableHandle
          withHandle
          className={cn(!media_expanded && "hidden")}
          aria-label="调整总结参考视频高度"
        />
        <ResizablePanel
          id="summary-editor-workspace"
          minSize={`${SUMMARY_EDITOR_MIN_HEIGHT_PX}px`}
          className="min-h-0 overflow-hidden"
        >
          <SummaryWorkspace
            key={selected_asset_id ?? "no-selected-asset"}
            selected_asset={selected_asset}
            on_error={set_page_error}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
      {error ? <FloatingError message={error} /> : null}
    </>
  );
}
