import { Bot } from "lucide-react";

import { AgentPanel } from "@/components/AgentPanel";
import type { AgentContextAttachmentDraft } from "@/components/agent_context";
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
  AgentThinkingMode,
  AiModelSummary,
  FocusSelection,
  MediaMarker,
} from "@/shared/types";

type MarkerAgentPanelProps = {
  asset_id: string | null;
  models: AiModelSummary[];
  on_seek: (seconds: number) => void;
  current_time: number;
  on_candidate_markers_change: (markers: MediaMarker[]) => void;
  on_markers_changed: () => Promise<void>;
  focus_selection?: FocusSelection | null;
  default_thinking_mode?: AgentThinkingMode;
  compact?: boolean;
};

export function MarkerAgentPanel({
  asset_id,
  models,
  on_seek,
  current_time,
  on_candidate_markers_change,
  on_markers_changed,
  focus_selection = null,
  default_thinking_mode = "auto",
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
          current_time={current_time}
          placeholder="例如：这个课程主要讲什么？"
          context_attachments={time_range_attachment(focus_selection)}
          default_thinking_mode={default_thinking_mode}
          thinking_modes_enabled
          library_scope_enabled
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

function time_range_attachment(
  selection: FocusSelection | null,
): AgentContextAttachmentDraft[] {
  if (
    selection?.in_seconds === null ||
    selection?.out_seconds === null ||
    !selection
  ) {
    return [];
  }
  return [
    {
      draft_id: `${selection.selection_id}-${selection.revision}`,
      kind: "time_range",
      asset_id: selection.asset_id,
      label: "时间线理解范围",
      reference_id: selection.selection_id,
      start_seconds: selection.in_seconds,
      end_seconds: selection.out_seconds,
    },
  ];
}
