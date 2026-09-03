import { Outlet, useLocation } from "react-router-dom";

import { Topbar } from "@/app/Topbar";
import { GlobalAssistantLayout } from "@/app/global_assistant";
import { GlobalMediaImport } from "@/app/GlobalMediaImport";
import { use_library_state } from "@/app/library";
import {
  MARKERS_ROUTE_PATH,
  SUMMARY_ROUTE_PATH,
  workspace_route,
} from "@/app/workspace_routes";
import { LibraryIndexIssuesAlert } from "@/features/library/LibraryIndexIssuesAlert";
import { cn } from "@/lib/utils";

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
      <GlobalMediaImport />
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
            <Outlet />
          </main>
        </div>
      </GlobalAssistantLayout>
    </div>
  );
}
