import { lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "@/app/AppShell";
import { AssetCatalogProvider } from "@/app/asset_catalog";
import { TaskManagerProvider } from "@/app/task_manager";

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
      <AssetCatalogProvider>
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
    </BrowserRouter>
  );
}
