import { MotionConfig } from "motion/react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "@/app/AppShell";
import { AssetCatalogProvider } from "@/app/asset_catalog";
import { BackendConnectionGate } from "@/app/backend_connection";
import { ApplicationQueryProvider } from "@/app/query_cache";
import { TaskManagerProvider } from "@/app/task_manager";
import { GlobalAssistantProvider } from "@/app/global_assistant";
import { LibraryProvider, use_library_state } from "@/app/library";
import { LocalPreferencesProvider } from "@/app/local_preferences";
import { WorkspaceRouter } from "@/app/WorkspaceRouter";
import { LibrarySetup } from "@/features/library/LibrarySetup";

export function App() {
  return (
    <MotionConfig reducedMotion="user">
      <LocalPreferencesProvider>
        <BackendConnectionGate>
          <BrowserRouter>
            <LibraryProvider>
              <ApplicationRoutes />
            </LibraryProvider>
          </BrowserRouter>
        </BackendConnectionGate>
      </LocalPreferencesProvider>
    </MotionConfig>
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
  if (library) return <Navigate to="/library" replace />;
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
