import { Captions, FileText, ScanLine, X } from "lucide-react";

import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { format_time } from "@/shared/format";
import type { AgentContextAttachment } from "@/shared/types";
import type { AgentContextAttachmentDraft } from "./agent_context";

type VisibleContextAttachment =
  AgentContextAttachment | AgentContextAttachmentDraft;

export function AgentContextAttachments({
  attachments,
  on_remove,
  label = "消息上下文附件",
}: {
  attachments: VisibleContextAttachment[];
  on_remove?: (attachment_id: string) => void;
  label?: string;
}) {
  if (attachments.length === 0) return null;
  return (
    <AttachmentGroup aria-label={label}>
      {attachments.map((attachment) => {
        const attachment_id = visible_attachment_id(attachment);
        return (
          <AgentContextAttachmentCard
            key={attachment_id}
            attachment={attachment}
            on_remove={on_remove ? () => on_remove(attachment_id) : undefined}
          />
        );
      })}
    </AttachmentGroup>
  );
}

function AgentContextAttachmentCard({
  attachment,
  on_remove,
}: {
  attachment: VisibleContextAttachment;
  on_remove?: () => void;
}) {
  const Icon =
    attachment.kind === "time_range"
      ? ScanLine
      : attachment.kind === "transcript_selection"
        ? Captions
        : FileText;
  return (
    <Attachment size="sm" state="done">
      <AttachmentMedia variant="icon">
        <Icon />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{attachment.label}</AttachmentTitle>
        <AttachmentDescription>
          {attachment_description(attachment)}
        </AttachmentDescription>
      </AttachmentContent>
      {on_remove ? (
        <AttachmentActions>
          <AttachmentAction
            type="button"
            aria-label={`移除${attachment.label}`}
            onClick={on_remove}
          >
            <X />
          </AttachmentAction>
        </AttachmentActions>
      ) : null}
    </Attachment>
  );
}

function visible_attachment_id(attachment: VisibleContextAttachment): string {
  return "draft_id" in attachment
    ? attachment.draft_id
    : attachment.attachment_id;
}

function attachment_description(attachment: VisibleContextAttachment) {
  if (attachment.kind === "time_range") {
    const start = attachment.start_seconds;
    const end = attachment.end_seconds;
    if (typeof start === "number" && typeof end === "number") {
      return `${format_time(start)}–${format_time(end)} · 按需读取证据`;
    }
    return "时间范围 · 按需读取证据";
  }
  const characters = attachment.snapshot_text?.length ?? 0;
  return `${attachment.kind === "summary_selection" ? "总结选区" : "字幕选区"} · ${characters} 字`;
}
