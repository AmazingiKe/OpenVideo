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
import { ApplicationQueryProvider } from "@/app/query_cache";
import { TaskManagerProvider } from "@/app/task_manager";
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
    <BrowserRouter>
      <LibraryProvider>
        <ApplicationRoutes />
      </LibraryProvider>
    </BrowserRouter>
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
          <Routes>
            <Route element={<AppShell />}>
              <Route path="*" element={<WorkspaceRouter />} />
            </Route>
          </Routes>
        </TaskManagerProvider>
      </AssetCatalogProvider>
    </ApplicationQueryProvider>
  );
}

function WorkspaceRouter() {
  const location = useLocation();
  const [visited_paths, set_visited_paths] = useState(
    () => new Set([location.pathname]),
  );
  const active_workspace_route = workspace_route(location.pathname);
  const is_settings_active = location.pathname === SETTINGS_ROUTE.path;
  useEffect(() => {
    if (!active_workspace_route && !is_settings_active) return;
    set_visited_paths((current) => {
      if (current.has(location.pathname)) return current;
      return new Set([...current, location.pathname]);
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
        return (
          <Activity key={route.path} mode={is_active ? "visible" : "hidden"}>
            <Suspense fallback={is_active ? <WorkspaceLoading /> : null}>
              <WorkspacePage />
            </Suspense>
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
