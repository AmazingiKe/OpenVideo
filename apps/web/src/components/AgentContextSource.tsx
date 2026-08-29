import { Bot, GripVertical } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { format_time } from "@/shared/format";
import {
  renew_context_attachment_draft,
  write_context_attachment_drag_data,
  type AgentContextAttachmentDraft,
} from "./agent_context";

export function AgentContextSource({
  attachment,
  on_add,
  compact = false,
}: {
  attachment: AgentContextAttachmentDraft;
  on_add: (attachment: AgentContextAttachmentDraft) => void;
  compact?: boolean;
}) {
  const description = source_description(attachment);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn(
        "cursor-grab justify-start active:cursor-grabbing",
        compact ? "max-w-48" : "max-w-64",
      )}
      draggable
      onDragStart={(event) =>
        write_context_attachment_drag_data(event.dataTransfer, attachment)
      }
      onClick={() => on_add(renew_context_attachment_draft(attachment))}
      aria-label={`将${attachment.label}添加给 AI；也可拖到助手`}
      title={`${description}；可拖到助手`}
      data-slot="agent-context-source"
    >
      <GripVertical data-icon="inline-start" aria-hidden="true" />
      <span className="truncate">{attachment.label}</span>
      {!compact ? (
        <span className="shrink-0 text-muted-foreground">{description}</span>
      ) : null}
      <Bot className="shrink-0" aria-hidden="true" />
      <span className="shrink-0">{compact ? "给 AI" : "添加给 AI"}</span>
    </Button>
  );
}

function source_description(attachment: AgentContextAttachmentDraft) {
  if (
    typeof attachment.start_seconds === "number" &&
    typeof attachment.end_seconds === "number"
  ) {
    return `${format_time(attachment.start_seconds)}–${format_time(attachment.end_seconds)}`;
  }
  return `${attachment.snapshot_text?.length ?? 0} 字`;
}
