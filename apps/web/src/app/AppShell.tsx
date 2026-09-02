import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { Outlet, useLocation } from "react-router-dom";

import { Topbar } from "@/app/Topbar";
import { GlobalAssistantLayout } from "@/app/global_assistant";
import { use_library_state } from "@/app/library";
import {
  MARKERS_ROUTE_PATH,
  SUMMARY_ROUTE_PATH,
  workspace_route,
} from "@/app/workspace_routes";
import { LibraryIndexIssuesAlert } from "@/features/library/LibraryIndexIssuesAlert";
import { SharedPlayerWorkspace } from "@/features/player/SharedPlayerWorkspace";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";

const STACKED_PLAYBACK_LAYOUT_QUERY = "(max-width: 1024px)";
const MINI_PLAYBACK_LAYOUT_QUERY = "(max-width: 640px)";

export function AppShell() {
  const location = useLocation();
  const { library } = use_library_state();
  const active_workspace_path = workspace_route(location.pathname)?.path;
  const uses_fixed_workspace_layout =
    active_workspace_path === MARKERS_ROUTE_PATH ||
    active_workspace_path === SUMMARY_ROUTE_PATH;

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background">
      <Topbar />
      <GlobalAssistantLayout>
        <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
          {library && library.index_issues.length > 0 ? (
            <div className="max-h-48 overflow-auto border-b bg-background p-2">
              <LibraryIndexIssuesAlert issues={library.index_issues} />
            </div>
          ) : null}
          <main
            className={cn(
              "row-start-2 min-h-0",
              uses_fixed_workspace_layout
                ? "overflow-hidden"
                : "overflow-auto bg-surface-subtle",
            )}
          >
            <SharedPlaybackLayout
              workspace_path={
                uses_fixed_workspace_layout ? active_workspace_path! : null
              }
            >
              <Outlet />
            </SharedPlaybackLayout>
          </main>
        </div>
      </GlobalAssistantLayout>
    </div>
  );
}

function SharedPlaybackLayout({
  workspace_path,
  children,
}: {
  workspace_path: typeof MARKERS_ROUTE_PATH | typeof SUMMARY_ROUTE_PATH | null;
  children: ReactNode;
}) {
  const stacked = use_stacked_playback_layout();
  const mini_layout = use_media_query(MINI_PLAYBACK_LAYOUT_QUERY);
  const [mini_player_expanded, set_mini_player_expanded] = useState(false);
  const player_panel_ref = useRef<PanelImperativeHandle>(null);
  const media_workspace_active = workspace_path !== null;
  const compact_player =
    media_workspace_active && mini_layout && !mini_player_expanded;
  const orientation =
    workspace_path === SUMMARY_ROUTE_PATH && !stacked
      ? "horizontal"
      : "vertical";
  const player_default_size = !media_workspace_active
    ? "0px"
    : compact_player
      ? "72px"
      : orientation === "horizontal"
        ? "40%"
        : workspace_path === MARKERS_ROUTE_PATH
          ? "58%"
          : "42%";

  useEffect(() => {
    if (!media_workspace_active) {
      player_panel_ref.current?.collapse();
      return;
    }
    player_panel_ref.current?.resize(player_default_size);
  }, [media_workspace_active, player_default_size]);

  useEffect(() => {
    if (!mini_layout) set_mini_player_expanded(false);
  }, [mini_layout]);

  return (
    <ResizablePanelGroup
      id="shared-playback-workspace"
      orientation={orientation}
      className="h-full min-h-0 min-w-0"
    >
      <ResizablePanel
        id="shared-player"
        panelRef={player_panel_ref}
        defaultSize={player_default_size}
        minSize={
          media_workspace_active
            ? compact_player
              ? "72px"
              : orientation === "horizontal"
                ? "320px"
                : "144px"
            : "0px"
        }
        maxSize={
          compact_player ? "72px" : orientation === "horizontal" ? "65%" : "72%"
        }
        collapsedSize="0px"
        collapsible
        className="min-h-0 min-w-0 overflow-hidden"
      >
        <SharedPlayerWorkspace
          compact={compact_player}
          on_expand={() => set_mini_player_expanded(true)}
          on_minimize={
            mini_layout && mini_player_expanded
              ? () => set_mini_player_expanded(false)
              : undefined
          }
        />
      </ResizablePanel>
      <ResizableHandle
        withHandle
        className={cn((!media_workspace_active || compact_player) && "hidden")}
        aria-label={
          orientation === "horizontal"
            ? "调整播放器与笔记宽度"
            : "调整播放器高度"
        }
      />
      <ResizablePanel
        id="active-workspace"
        defaultSize={
          !media_workspace_active
            ? "100%"
            : orientation === "horizontal"
              ? "60%"
              : "42%"
        }
        minSize={
          media_workspace_active
            ? orientation === "horizontal"
              ? "360px"
              : "176px"
            : "100%"
        }
        className={cn(
          "min-h-0 min-w-0",
          media_workspace_active ? "overflow-hidden" : "overflow-visible",
        )}
      >
        {children}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function use_stacked_playback_layout() {
  return use_media_query(STACKED_PLAYBACK_LAYOUT_QUERY);
}

function use_media_query(query_text: string) {
  const [matches, set_matches] = useState(
    () => window.matchMedia?.(query_text).matches ?? false,
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia(query_text);
    const update = () => set_matches(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [query_text]);
  return matches;
}
