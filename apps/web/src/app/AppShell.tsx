import { Outlet, useLocation } from "react-router-dom";

import { Topbar } from "@/app/Topbar";
import { use_library_state } from "@/app/library";
import { LibraryIndexIssuesAlert } from "@/features/library/LibraryIndexIssuesAlert";
import { cn } from "@/lib/utils";

export function AppShell() {
  const location = useLocation();
  const { library } = use_library_state();
  const is_analysis_page = location.pathname === "/analysis";

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background">
      <Topbar />
      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
        {library && library.index_issues.length > 0 ? (
          <div className="max-h-48 overflow-auto border-b bg-background p-2">
            <LibraryIndexIssuesAlert issues={library.index_issues} />
          </div>
        ) : null}
        <main
          className={cn(
            "min-h-0",
            is_analysis_page
              ? "grid grid-rows-[minmax(0,1fr)_262px] overflow-hidden max-[820px]:grid-rows-[minmax(460px,1fr)_238px]"
              : "overflow-auto bg-muted/20",
          )}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
