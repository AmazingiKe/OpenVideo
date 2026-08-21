import {
  Clapperboard,
  Download,
  FileText,
  ScanSearch,
  Settings,
} from "lucide-react";
import { NavLink } from "react-router-dom";

import { cn } from "@/lib/utils";

const WORKSPACE_MODULES = [
  { label: "下载", path: "/downloads", icon: Download },
  { label: "分析", path: "/analysis", icon: ScanSearch },
  { label: "总结", path: "/summary", icon: FileText },
] as const;

export function Topbar() {
  return (
    <header className="workbench_header">
      <div className="workbench_brand">
        <Clapperboard aria-hidden="true" />
        <strong>OpenVideo</strong>
      </div>
      <nav className="workbench_navigation" aria-label="工作区导航">
        {WORKSPACE_MODULES.map((module) => {
          const ModuleIcon = module.icon;
          return (
            <NavLink
              key={module.path}
              to={module.path}
              className={({ isActive }) => (isActive ? "active" : undefined)}
            >
              <ModuleIcon aria-hidden="true" />
              {module.label}
            </NavLink>
          );
        })}
      </nav>
      <NavLink
        className={({ isActive }) =>
          cn("topbar_settings_link", isActive && "active")
        }
        to="/settings"
        aria-label="设置"
      >
        <Settings aria-hidden="true" />
      </NavLink>
    </header>
  );
}
