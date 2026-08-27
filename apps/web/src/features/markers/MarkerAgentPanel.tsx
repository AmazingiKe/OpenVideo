import { Bot } from "lucide-react";

import { AgentPanel } from "@/components/AgentPanel";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { CollapsiblePanelRail } from "@/features/workbench/CollapsiblePanelRail";
import type {
  AgentArtifact,
  AiModelSummary,
  MediaMarker,
} from "@/shared/types";

type MarkerAgentPanelProps = {
  asset_id: string | null;
  models: AiModelSummary[];
  on_seek: (seconds: number) => void;
  on_candidate_markers_change: (markers: MediaMarker[]) => void;
  on_markers_changed: () => Promise<void>;
  collapsed?: boolean;
  on_collapsed_change?: (collapsed: boolean) => void;
};

export function MarkerAgentPanel({
  asset_id,
  models,
  on_seek,
  on_candidate_markers_change,
  on_markers_changed,
  collapsed = false,
  on_collapsed_change,
}: MarkerAgentPanelProps) {
  if (collapsed) {
    return (
      <aside className="h-full overflow-hidden bg-card" aria-label="标记 Agent">
        <CollapsiblePanelRail
          icon={Bot}
          label="Agent"
          edge="left"
          on_expand={() => on_collapsed_change?.(false)}
        />
      </aside>
    );
  }

  if (!asset_id) {
    return (
      <Empty className="h-full rounded-none border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Bot />
          </EmptyMedia>
          <EmptyTitle>请先选择视频</EmptyTitle>
          <EmptyDescription>Agent 只处理当前播放器中的视频。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <aside className="h-full min-h-80 min-w-0 bg-card" aria-label="标记 Agent">
      <AgentPanel
        className="h-full rounded-none border-0"
        agent_id="marker"
        asset_id={asset_id}
        models={models}
        on_seek={on_seek}
        placeholder="例如：找出所有结论并生成范围标记预览"
        on_artifact_change={handle_artifact}
      />
    </aside>
  );

  async function handle_artifact(artifact: AgentArtifact) {
    if (artifact.result_type !== "marker_changes") return;
    if (artifact.status === "approved") {
      on_candidate_markers_change([]);
      await on_markers_changed();
      return;
    }
    if (artifact.status !== "pending") {
      on_candidate_markers_change([]);
      return;
    }
    const changes = Array.isArray(artifact.payload.changes)
      ? (artifact.payload.changes as Record<string, unknown>[])
      : [];
    on_candidate_markers_change(
      changes.flatMap((change) => {
        if (typeof change.after !== "object" || change.after === null)
          return [];
        return [change.after as MediaMarker];
      }),
    );
  }
}
