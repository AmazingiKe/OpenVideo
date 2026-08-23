import { Suspense } from "react";
import { Outlet, useLocation } from "react-router-dom";

import { Topbar } from "@/app/Topbar";
import { Spinner } from "@/components/ui/spinner";
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
        <Suspense fallback={<RouteLoading />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}

function RouteLoading() {
  return (
    <div className="grid min-h-full place-items-center" role="status">
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        正在加载页面
      </span>
    </div>
  );
}
