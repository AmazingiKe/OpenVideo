import { Activity, Suspense, useEffect, useState } from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";

import { AppShell } from "@/app/AppShell";
import { AssetCatalogProvider } from "@/app/asset_catalog";
import { BackendConnectionGate } from "@/app/backend_connection";
import { ApplicationQueryProvider } from "@/app/query_cache";
import { TaskManagerProvider } from "@/app/task_manager";
import { GlobalAssistantProvider } from "@/app/global_assistant";
import { LibraryProvider, use_library_state } from "@/app/library";
import { WorkspaceLoading } from "@/app/WorkspaceLoading";
import {
  SETTINGS_ROUTE,
  WORKSPACE_ROUTES,
  workspace_route,
} from "@/app/workspace_routes";
import { LibrarySetup } from "@/features/library/LibrarySetup";

export function App() {
  return (
    <BackendConnectionGate>
      <BrowserRouter>
        <LibraryProvider>
          <ApplicationRoutes />
        </LibraryProvider>
      </BrowserRouter>
    </BackendConnectionGate>
  );
}

function ApplicationRoutes() {
  return (
    <Routes>
      <Route path="/initialize" element={<InitializeLibraryPage />} />
      <Route path="*" element={<LibraryGate />} />
    </Routes>
  );
}

function InitializeLibraryPage() {
  const { library, notice, set_library } = use_library_state();
  if (library) return <Navigate to="/downloads" replace />;
  return <LibrarySetup notice={notice} on_library_opened={set_library} />;
}

function LibraryGate() {
  const { library } = use_library_state();
  if (!library) return <Navigate to="/initialize" replace />;
  return (
    <ApplicationQueryProvider key={library.library_id}>
      <AssetCatalogProvider>
        <TaskManagerProvider>
          <GlobalAssistantProvider>
            <Routes>
              <Route element={<AppShell />}>
                <Route path="*" element={<WorkspaceRouter />} />
              </Route>
            </Routes>
          </GlobalAssistantProvider>
        </TaskManagerProvider>
      </AssetCatalogProvider>
    </ApplicationQueryProvider>
  );
}

function WorkspaceRouter() {
  const location = useLocation();
  const active_workspace_route = workspace_route(location.pathname);
  const is_settings_active = location.pathname === SETTINGS_ROUTE.path;
  const [visited_paths, set_visited_paths] = useState(
    () =>
      new Set([
        active_workspace_route?.path ??
          (is_settings_active ? SETTINGS_ROUTE.path : location.pathname),
      ]),
  );
  useEffect(() => {
    if (!active_workspace_route && !is_settings_active) return;
    const active_path = active_workspace_route?.path ?? SETTINGS_ROUTE.path;
    set_visited_paths((current) => {
      if (current.has(active_path)) return current;
      return new Set([...current, active_path]);
    });
  }, [active_workspace_route, is_settings_active, location.pathname]);
  if (!active_workspace_route && !is_settings_active) {
    return <Navigate to="/downloads" replace />;
  }
  const SettingsPage = SETTINGS_ROUTE.component;
  return (
    <>
      {WORKSPACE_ROUTES.map((route) => {
        const WorkspacePage = route.component;
        const is_active = route.path === active_workspace_route?.path;
        if (!is_active && !visited_paths.has(route.path)) return null;
        const workspace_page = (
          <Suspense
            key={route.path}
            fallback={is_active ? <WorkspaceLoading /> : null}
          >
            <WorkspacePage />
          </Suspense>
        );
        if (!route.preserve_state_when_hidden) {
          return is_active ? workspace_page : null;
        }
        return (
          <Activity key={route.path} mode={is_active ? "visible" : "hidden"}>
            {workspace_page}
          </Activity>
        );
      })}
      {is_settings_active || visited_paths.has(SETTINGS_ROUTE.path) ? (
        <Activity mode={is_settings_active ? "visible" : "hidden"}>
          <Suspense fallback={is_settings_active ? <WorkspaceLoading /> : null}>
            <SettingsPage />
          </Suspense>
        </Activity>
      ) : null}
    </>
  );
}
