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
  AgentEvidenceReference,
  AgentThinkingMode,
  AiModelSummary,
  MediaMarker,
} from "@/shared/types";

type MarkerAgentPanelProps = {
  asset_id: string | null;
  models: AiModelSummary[];
  on_seek: (
    seconds: number,
    end_seconds?: number | null,
    evidence?: AgentEvidenceReference,
  ) => void;
  current_time: number;
  context_attachments?: AgentContextAttachmentDraft[];
  on_candidate_markers_change: (markers: MediaMarker[]) => void;
  on_markers_changed: () => Promise<void>;
  default_thinking_mode?: AgentThinkingMode;
  compact?: boolean;
};

export function MarkerAgentPanel({
  asset_id,
  models,
  on_seek,
  current_time,
  context_attachments = [],
  on_candidate_markers_change,
  on_markers_changed,
  default_thinking_mode = "auto",
  compact = false,
}: MarkerAgentPanelProps) {
  return (
    <aside
      className={cn(
        "min-h-0 min-w-0 bg-card",
        compact ? "h-[36rem] shrink-0 border-t" : "h-full",
      )}
      aria-label="助手"
      data-slot="marker-agent-panel"
    >
      {!asset_id ? (
        <Empty className="h-full rounded-none border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Bot />
            </EmptyMedia>
            <EmptyTitle>请先选择视频</EmptyTitle>
            <EmptyDescription>助手只处理当前播放器中的视频。</EmptyDescription>
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
          placeholder="询问视频内容，或直接描述希望创建的标记…"
          context_attachments={context_attachments}
          default_thinking_mode={default_thinking_mode}
          thinking_modes_enabled
          library_scope_enabled
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
