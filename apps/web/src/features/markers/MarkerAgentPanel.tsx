import { Bot } from "lucide-react";

import { AgentPanel } from "@/components/AgentPanel";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";
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
  compact?: boolean;
};

export function MarkerAgentPanel({
  asset_id,
  models,
  on_seek,
  on_candidate_markers_change,
  on_markers_changed,
  compact = false,
}: MarkerAgentPanelProps) {
  return (
    <aside
      className={cn(
        "min-h-0 min-w-0 bg-card",
        compact ? "h-[36rem] shrink-0 border-t" : "h-full",
      )}
      aria-label="标记 Agent"
      data-slot="marker-agent-panel"
    >
      {!asset_id ? (
        <Empty className="h-full rounded-none border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Bot />
            </EmptyMedia>
            <EmptyTitle>请先选择视频</EmptyTitle>
            <EmptyDescription>
              Agent 只处理当前播放器中的视频。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <AgentPanel
          className="h-full rounded-none border-0"
          agent_id="marker"
          asset_id={asset_id}
          models={models}
          on_seek={on_seek}
          placeholder="例如：这个课程主要讲什么？"
          run_options={[
            {
              value: "chat",
              label: "内容问答",
              description: "检索视频证据并回答问题，不创建标记建议。",
              task_input: { intent: "chat" },
              required_capabilities: ["tools"],
            },
            {
              value: "edit",
              label: "生成标记建议",
              description: "生成整批标记变更预览，确认后才会修改标记。",
              task_input: { intent: "edit" },
              required_capabilities: ["tools"],
            },
          ]}
          on_artifact_change={handle_artifact}
        />
      )}
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
