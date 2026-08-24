import { lazy, type ComponentType, type LazyExoticComponent } from "react";

type PageModule = Promise<{ default: ComponentType }>;
export type WorkspacePath = "/downloads" | "/analysis" | "/summary";

type WorkspaceRoute = {
  label: string;
  path: WorkspacePath;
  component: LazyExoticComponent<ComponentType>;
  load_component: () => PageModule;
};

const load_downloads_page = () =>
  import("@/pages/DownloadsPage").then((module) => ({
    default: module.DownloadsPage,
  }));
const load_analysis_page = () =>
  import("@/pages/AnalysisPage").then((module) => ({
    default: module.AnalysisPage,
  }));
const load_summary_page = () =>
  import("@/pages/SummaryPage").then((module) => ({
    default: module.SummaryPage,
  }));
const load_settings_page = () =>
  import("@/features/settings/SettingsPage").then((module) => ({
    default: module.SettingsPage,
  }));

export const WORKSPACE_ROUTES: WorkspaceRoute[] = [
  {
    label: "下载",
    path: "/downloads",
    component: lazy(load_downloads_page),
    load_component: load_downloads_page,
  },
  {
    label: "分析",
    path: "/analysis",
    component: lazy(load_analysis_page),
    load_component: load_analysis_page,
  },
  {
    label: "总结",
    path: "/summary",
    component: lazy(load_summary_page),
    load_component: load_summary_page,
  },
];

export const SETTINGS_ROUTE = {
  path: "/settings",
  component: lazy(load_settings_page),
  load_component: load_settings_page,
} as const;

export function workspace_route(pathname: string): WorkspaceRoute | null {
  return WORKSPACE_ROUTES.find((route) => route.path === pathname) ?? null;
}
