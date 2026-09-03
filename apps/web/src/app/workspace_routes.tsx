import { lazy, type ComponentType, type LazyExoticComponent } from "react";

type PageModule = Promise<{ default: ComponentType }>;
export type WorkspacePath = "/library" | "/markers" | "/summary";

export const MARKERS_ROUTE_PATH: WorkspacePath = "/markers";
export const SUMMARY_ROUTE_PATH: WorkspacePath = "/summary";

type WorkspaceRoute = {
  label: string;
  path: WorkspacePath;
  component: LazyExoticComponent<ComponentType>;
  load_component: () => PageModule;
  preserve_state_when_hidden: boolean;
};

const load_markers_page = () =>
  import("@/pages/MarkersPage").then((module) => ({
    default: module.MarkersPage,
  }));
const load_library_page = () =>
  import("@/pages/LibraryPage").then((module) => ({
    default: module.LibraryPage,
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
    label: "视频库",
    path: "/library",
    component: lazy(load_library_page),
    load_component: load_library_page,
    preserve_state_when_hidden: true,
  },
  {
    label: "标记",
    path: MARKERS_ROUTE_PATH,
    component: lazy(load_markers_page),
    load_component: load_markers_page,
    // Vidstack 的 React 桥接层不能在 Activity 隐藏后重新挂载。
    preserve_state_when_hidden: false,
  },
  {
    label: "总结",
    path: SUMMARY_ROUTE_PATH,
    component: lazy(load_summary_page),
    load_component: load_summary_page,
    // 总结页同样包含独立播放器，切换时必须完整销毁播放器实例。
    preserve_state_when_hidden: false,
  },
];

export const SETTINGS_ROUTE = {
  path: "/settings",
  component: lazy(load_settings_page),
  load_component: load_settings_page,
} as const;

export function workspace_route(pathname: string): WorkspaceRoute | null {
  return (
    WORKSPACE_ROUTES.find(
      (route) =>
        route.path === pathname ||
        (route.path === MARKERS_ROUTE_PATH &&
          pathname.startsWith(`${MARKERS_ROUTE_PATH}/`)),
    ) ?? null
  );
}

export function marker_asset_path(asset_id: string): string {
  return `${MARKERS_ROUTE_PATH}/${encodeURIComponent(asset_id)}`;
}

export function marker_asset_id(pathname: string): string | null {
  const prefix = `${MARKERS_ROUTE_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  const encoded_asset_id = pathname.slice(prefix.length);
  if (!encoded_asset_id || encoded_asset_id.includes("/")) return null;
  try {
    return decodeURIComponent(encoded_asset_id);
  } catch {
    return null;
  }
}
