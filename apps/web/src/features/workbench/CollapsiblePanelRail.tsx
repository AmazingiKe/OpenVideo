import { type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

// 收起后的轨道宽度，ResizablePanel 的 collapsedSize 必须与之一致
export const PANEL_RAIL_WIDTH_PX = 48;

type CollapsiblePanelRailProps = {
  icon: LucideIcon;
  label: string;
  /** 轨道贴靠的边缘，保证宽度动画期间轨道停在面板外侧不晃动 */
  edge: "left" | "right";
  on_expand: () => void;
};

export function CollapsiblePanelRail({
  icon: Icon,
  label,
  edge,
  on_expand,
}: CollapsiblePanelRailProps) {
  return (
    <button
      className={cn(
        "flex h-full flex-col items-center gap-2 border-x bg-card px-1 py-3 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        edge === "right" && "ml-auto",
      )}
      style={{ width: PANEL_RAIL_WIDTH_PX }}
      type="button"
      onClick={on_expand}
      aria-label={`展开${label}`}
      title={`展开${label}`}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-h-0 overflow-hidden text-xs font-medium tracking-wider [writing-mode:vertical-rl]">
        {label}
      </span>
    </button>
  );
}
