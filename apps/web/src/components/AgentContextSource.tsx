import { Captions, Crosshair, Plus, TextSelect } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { format_time } from "@/shared/format";
import {
  renew_context_attachment_draft,
  type AgentContextAttachmentDraft,
} from "./agent_context";

export function AgentContextSource({
  attachment,
  on_add,
}: {
  attachment: AgentContextAttachmentDraft;
  on_add: (attachment: AgentContextAttachmentDraft) => void;
}) {
  const description = source_description(attachment);
  const Icon =
    attachment.kind === "transcript_selection"
      ? Captions
      : attachment.kind === "summary_selection"
        ? TextSelect
        : Crosshair;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-auto w-full justify-start py-2"
      onClick={() => on_add(renew_context_attachment_draft(attachment))}
      aria-label={`添加${attachment.label}上下文`}
      title={attachment.snapshot_text ?? description}
      data-slot="agent-context-source"
    >
      <Icon data-icon="inline-start" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <span className="max-w-full truncate">{attachment.label}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
      <Plus data-icon="inline-end" aria-hidden="true" />
    </Button>
  );
}

export function AgentContextMenuItem({
  on_add,
  label = "添加上下文",
}: {
  on_add: () => void;
  label?: string;
}) {
  return (
    <ContextMenuItem onSelect={on_add}>
      <Plus aria-hidden="true" />
      {label}
    </ContextMenuItem>
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
