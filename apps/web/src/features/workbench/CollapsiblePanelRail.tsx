import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

type CollapsiblePanelRailProps = {
  icon: LucideIcon;
  label: string;
  expand_direction: "left" | "right";
  on_expand: () => void;
};

export function CollapsiblePanelRail({
  icon: Icon,
  label,
  expand_direction,
  on_expand,
}: CollapsiblePanelRailProps) {
  const ExpandIcon = expand_direction === "left" ? ChevronLeft : ChevronRight;

  return (
    <div
      className="flex h-full min-h-0 flex-col items-center gap-2 border-x bg-card px-1 py-3 text-muted-foreground"
      title={label}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-h-0 overflow-hidden text-xs font-medium tracking-wider [writing-mode:vertical-rl]">
        {label}
      </span>
      <Button
        className="mt-auto"
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={on_expand}
        aria-label={`展开${label}`}
      >
        <ExpandIcon data-icon="inline-start" aria-hidden="true" />
      </Button>
    </div>
  );
}
