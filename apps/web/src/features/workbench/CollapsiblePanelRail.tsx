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
    <div className="collapsible_panel_rail" title={label}>
      <Icon aria-hidden="true" />
      <span>{label}</span>
      <Button
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
