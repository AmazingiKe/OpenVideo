import { Outlet, useLocation } from "react-router-dom";

import { Topbar } from "@/app/Topbar";
import { use_asset_catalog } from "@/app/asset_catalog";
import { use_library_state } from "@/app/library";
import { MARKERS_ROUTE_PATH, workspace_route } from "@/app/workspace_routes";
import { LibraryIndexIssuesAlert } from "@/features/library/LibraryIndexIssuesAlert";
import { cn } from "@/lib/utils";

export function AppShell() {
  const location = useLocation();
  const { library } = use_library_state();
  const { assets, selected_asset_id } = use_asset_catalog();
  const is_markers_page =
    workspace_route(location.pathname)?.path === MARKERS_ROUTE_PATH;

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background">
      <Topbar assets={assets} selected_asset_id={selected_asset_id} />
      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
        {library && library.index_issues.length > 0 ? (
          <div className="max-h-48 overflow-auto border-b bg-background p-2">
            <LibraryIndexIssuesAlert issues={library.index_issues} />
          </div>
        ) : null}
        <main
          className={cn(
            "min-h-0",
            is_markers_page
              ? "grid grid-rows-[minmax(0,1fr)_262px] overflow-hidden max-[820px]:grid-rows-[minmax(460px,1fr)_238px]"
              : "overflow-auto bg-surface-subtle",
          )}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
