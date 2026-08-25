import {
  Clapperboard,
  Download,
  FileText,
  Flag,
  Library,
  Settings,
} from "lucide-react";
import { useEffect } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";

import {
  MARKERS_ROUTE_PATH,
  SETTINGS_ROUTE,
  WORKSPACE_ROUTES,
  marker_asset_path,
  workspace_route,
} from "@/app/workspace_routes";
import { MarkerAssetMenu } from "@/features/markers/MarkerAssetMenu";
import { cn } from "@/lib/utils";
import type { MediaAsset } from "@/shared/types";

const IDLE_PRELOAD_TIMEOUT_MS = 2_000;

function preload_component(load_component: () => Promise<unknown>) {
  // 预加载只优化切换速度，失败时由用户实际进入页面后的 Suspense 正常重试。
  void load_component().catch(() => undefined);
}

const WORKSPACE_ICONS = {
  "/downloads": Download,
  "/library": Library,
  "/markers": Flag,
  "/summary": FileText,
} as const;

type TopbarProps = {
  assets: MediaAsset[];
  selected_asset_id: string | null;
};

export function Topbar({ assets, selected_asset_id }: TopbarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const is_markers_page =
    workspace_route(location.pathname)?.path === MARKERS_ROUTE_PATH;
  useEffect(() => {
    const preload_routes = () => {
      for (const route of WORKSPACE_ROUTES) {
        preload_component(route.load_component);
      }
      preload_component(SETTINGS_ROUTE.load_component);
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
              onPointerEnter={() => preload_component(module.load_component)}
              onFocus={() => preload_component(module.load_component)}
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
      <div className="col-start-2 row-start-1 flex min-w-0 items-center gap-2 justify-self-end md:col-start-3">
        {is_markers_page ? (
          <MarkerAssetMenu
            assets={assets}
            selected_asset_id={selected_asset_id}
            on_select={(asset_id) => navigate(marker_asset_path(asset_id))}
          />
        ) : null}
        <NavLink
          className={({ isActive }) =>
            cn(
              "flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
              isActive && "bg-muted text-foreground",
            )
          }
          to="/settings"
          aria-label="设置"
        >
          <Settings className="size-4" aria-hidden="true" />
        </NavLink>
      </div>
    </header>
  );
}
