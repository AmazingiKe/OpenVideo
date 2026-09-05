import { Suspense, useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { WorkspaceActiveContext } from "@/app/workspace_activity";
import { WorkspaceLoading } from "@/app/WorkspaceLoading";
import {
  MARKERS_ROUTE_PATH,
  SETTINGS_ROUTE,
  SUMMARY_ROUTE_PATH,
  WORKSPACE_ROUTES,
  workspace_route,
} from "@/app/workspace_routes";
import { cn } from "@/lib/utils";

const PAGE_ROUTES = [...WORKSPACE_ROUTES, SETTINGS_ROUTE];

export function WorkspaceRouter() {
  const { pathname } = useLocation();
  const active_path = workspace_route(pathname)?.path ?? pathname;
  const [visited_paths, set_visited_paths] = useState(
    () => new Set([active_path]),
  );

  useEffect(() => {
    set_visited_paths((current) => {
      if (current.has(active_path)) return current;
      return new Set([...current, active_path]);
    });
  }, [active_path]);

  if (!PAGE_ROUTES.some((route) => route.path === active_path)) {
    return <Navigate to="/library" replace />;
  }

  return PAGE_ROUTES.map((route) => {
    const is_active = route.path === active_path;
    if (!is_active && !visited_paths.has(route.path)) return null;
    const Page = route.component;
    const fixed_layout =
      route.path === MARKERS_ROUTE_PATH || route.path === SUMMARY_ROUTE_PATH;

    // Vidstack 和编辑器依赖持续挂载的 Effects，页面切换只隐藏 DOM。
    return (
      <WorkspaceActiveContext.Provider key={route.path} value={is_active}>
        <div
          hidden={!is_active}
          inert={!is_active}
          className={cn(
            "h-full min-h-0 min-w-0",
            fixed_layout ? "overflow-hidden" : "overflow-auto",
          )}
        >
          <Suspense fallback={<WorkspaceLoading />}>
            <Page />
          </Suspense>
        </div>
      </WorkspaceActiveContext.Provider>
    );
  });
}
