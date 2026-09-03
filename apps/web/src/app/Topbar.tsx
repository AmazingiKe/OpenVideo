import {
  Clapperboard,
  Bot,
  FileText,
  Flag,
  Library,
  Moon,
  Settings,
  Sun,
} from "lucide-react";
import { useEffect } from "react";
import { NavLink } from "react-router-dom";

import { SETTINGS_ROUTE, WORKSPACE_ROUTES } from "@/app/workspace_routes";
import { TaskCenter } from "@/app/TaskCenter";
import { use_global_assistant_controls } from "@/app/global_assistant";
import { use_local_preferences } from "@/app/local_preferences";
import { use_optional_task_manager } from "@/app/task_manager";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { use_color_scheme } from "@/use_color_scheme";

const IDLE_PRELOAD_TIMEOUT_MS = 2_000;

function preload_component(load_component: () => Promise<unknown>) {
  // 预加载只优化切换速度，失败时由用户实际进入页面后的 Suspense 正常重试。
  void load_component().catch(() => undefined);
}

const WORKSPACE_ICONS = {
  "/library": Library,
  "/markers": Flag,
  "/summary": FileText,
} as const;

export function Topbar() {
  const task_manager = use_optional_task_manager();
  const color_scheme = use_color_scheme();
  const { set_color_scheme } = use_local_preferences();
  const { assistant_open, set_assistant_open } =
    use_global_assistant_controls();
  const dark_mode_is_active = color_scheme === "dark";
  const color_scheme_action_label = dark_mode_is_active
    ? "切换到浅色模式"
    : "切换到深色模式";

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
    <header className="grid min-h-14 grid-cols-[1fr_auto] items-center gap-x-3 border-b bg-surface-translucent px-3 py-2 backdrop-blur-sm md:grid-cols-[minmax(10rem,1fr)_auto_minmax(10rem,1fr)] md:px-5">
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
                  "flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-focus-ring focus-visible:outline-none",
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
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={color_scheme_action_label}
          title={color_scheme_action_label}
          aria-pressed={dark_mode_is_active}
          onClick={() =>
            set_color_scheme(dark_mode_is_active ? "light" : "dark")
          }
        >
          {dark_mode_is_active ? (
            <Sun aria-hidden="true" />
          ) : (
            <Moon aria-hidden="true" />
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={assistant_open ? "收起全局助手" : "打开全局助手"}
          aria-pressed={assistant_open}
          onClick={() => set_assistant_open(!assistant_open)}
        >
          <Bot aria-hidden="true" />
        </Button>
        {task_manager ? (
          <TaskCenter
            tasks={task_manager.task_records}
            on_resume={task_manager.resume_agent_task}
          />
        ) : null}
        <NavLink
          className={({ isActive }) =>
            cn(
              "flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-focus-ring focus-visible:outline-none",
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
