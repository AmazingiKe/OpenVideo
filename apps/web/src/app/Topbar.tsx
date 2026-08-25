import {
  Clapperboard,
  Download,
  FileText,
  Flag,
  Library,
  Settings,
} from "lucide-react";
import { useEffect } from "react";
import { NavLink } from "react-router-dom";

import { SETTINGS_ROUTE, WORKSPACE_ROUTES } from "@/app/workspace_routes";
import { cn } from "@/lib/utils";

const IDLE_PRELOAD_TIMEOUT_MS = 2_000;

const WORKSPACE_ICONS = {
  "/downloads": Download,
  "/library": Library,
  "/markers": Flag,
  "/summary": FileText,
} as const;

export function Topbar() {
  useEffect(() => {
    const preload_routes = () => {
      for (const route of WORKSPACE_ROUTES) void route.load_component();
      void SETTINGS_ROUTE.load_component();
    };
    if (window.requestIdleCallback) {
      const idle_callback_id = window.requestIdleCallback(preload_routes, {
        timeout: IDLE_PRELOAD_TIMEOUT_MS,
      });
      return () => window.cancelIdleCallback(idle_callback_id);
    }
    const timeout_id = window.setTimeout(
      preload_routes,
      IDLE_PRELOAD_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timeout_id);
  }, []);

  return (
    <header className="grid min-h-14 grid-cols-[1fr_auto] items-center gap-x-3 border-b bg-background/95 px-3 py-2 backdrop-blur-sm md:grid-cols-[minmax(10rem,1fr)_auto_minmax(10rem,1fr)] md:px-5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Clapperboard className="size-4" aria-hidden="true" />
        </span>
        <strong className="truncate text-sm font-semibold tracking-tight">
          OpenVideo
        </strong>
      </div>
      <nav
        className="col-span-2 row-start-2 flex min-w-0 items-center gap-1 overflow-x-auto pt-2 md:col-span-1 md:col-start-2 md:row-start-1 md:justify-center md:pt-0"
        aria-label="工作区导航"
      >
        {WORKSPACE_ROUTES.map((module) => {
          const ModuleIcon = WORKSPACE_ICONS[module.path];
          return (
            <NavLink
              key={module.path}
              to={module.path}
              onPointerEnter={() => void module.load_component()}
              onFocus={() => void module.load_component()}
              className={({ isActive }) =>
                cn(
                  "flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  isActive && "bg-muted text-foreground",
                )
              }
            >
              <ModuleIcon className="size-4" aria-hidden="true" />
              {module.label}
            </NavLink>
          );
        })}
      </nav>
      <NavLink
        className={({ isActive }) =>
          cn(
            "col-start-2 row-start-1 flex size-8 items-center justify-center justify-self-end rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:col-start-3",
            isActive && "bg-muted text-foreground",
          )
        }
        to="/settings"
        aria-label="设置"
      >
        <Settings className="size-4" aria-hidden="true" />
      </NavLink>
    </header>
  );
}
