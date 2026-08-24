import { Outlet, useLocation } from "react-router-dom";

import { Topbar } from "@/app/Topbar";
import { cn } from "@/lib/utils";

export function AppShell() {
  const location = useLocation();
  const is_analysis_page = location.pathname === "/analysis";

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background">
      <Topbar />
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
  );
}
