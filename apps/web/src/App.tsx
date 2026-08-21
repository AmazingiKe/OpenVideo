import { lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "@/app/AppShell";
import { AssetCatalogProvider } from "@/app/asset_catalog";
import { TaskManagerProvider } from "@/app/task_manager";
import { LibraryProvider, use_library_state } from "@/app/library";
import { LibrarySetup } from "@/features/library/LibrarySetup";

const DownloadsPage = lazy(() =>
  import("@/pages/DownloadsPage").then((module) => ({
    default: module.DownloadsPage,
  })),
);
const AnalysisPage = lazy(() =>
  import("@/pages/AnalysisPage").then((module) => ({
    default: module.AnalysisPage,
  })),
);
const SummaryPage = lazy(() =>
  import("@/pages/SummaryPage").then((module) => ({
    default: module.SummaryPage,
  })),
);
const SettingsPage = lazy(() =>
  import("@/features/settings/SettingsPage").then((module) => ({
    default: module.SettingsPage,
  })),
);

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
    <AssetCatalogProvider key={library.library_id}>
      <TaskManagerProvider>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/downloads" element={<DownloadsPage />} />
            <Route path="/analysis" element={<AnalysisPage />} />
            <Route path="/summary" element={<SummaryPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/downloads" replace />} />
          </Route>
        </Routes>
      </TaskManagerProvider>
    </AssetCatalogProvider>
  );
}
