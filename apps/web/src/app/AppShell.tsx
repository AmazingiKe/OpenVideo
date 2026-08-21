import { Suspense } from "react";
import { Outlet, useLocation } from "react-router-dom";

import { Topbar } from "@/app/Topbar";
import { Spinner } from "@/components/ui/spinner";

export function AppShell() {
  const location = useLocation();
  const main_class =
    location.pathname === "/analysis" ? "workbench_main" : "module_main";

  return (
    <div className="workbench_shell">
      <Topbar />
      <main className={main_class}>
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
