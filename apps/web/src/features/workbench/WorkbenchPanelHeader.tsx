import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

type WorkbenchPanelHeaderProps = {
  icon: LucideIcon;
  title: string;
  accessory?: ReactNode;
  collapse_direction: "left" | "right";
  collapse_label: string;
  on_collapse?: () => void;
};

export function WorkbenchPanelHeader({
  icon: Icon,
  title,
  accessory,
  collapse_direction,
  collapse_label,
  on_collapse,
}: WorkbenchPanelHeaderProps) {
  const CollapseIcon =
    collapse_direction === "left" ? ChevronLeft : ChevronRight;

  return (
    <header className="flex min-h-12 items-center justify-between gap-2 border-b px-3">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 className="truncate text-sm font-medium">{title}</h2>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {accessory}
        {on_collapse ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={on_collapse}
            aria-label={collapse_label}
          >
            <CollapseIcon data-icon="inline-start" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </header>
  );
}
