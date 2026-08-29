import { uuid7 } from "@/shared/identifiers";
import type { AgentContextAttachment } from "@/shared/types";

export type AgentContextAttachmentDraft = Omit<
  AgentContextAttachment,
  "attachment_id" | "content_digest"
> & {
  draft_id: string;
};

export const AGENT_CONTEXT_ATTACHMENT_MIME =
  "application/x-openvideo-agent-context";

export function renew_context_attachment_draft(
  attachment: AgentContextAttachmentDraft,
): AgentContextAttachmentDraft {
  return {
    ...attachment,
    draft_id: `attachment-draft-${uuid7().replaceAll("-", "")}`,
  };
}

export function write_context_attachment_drag_data(
  data_transfer: DataTransfer,
  attachment: AgentContextAttachmentDraft,
) {
  const renewed_attachment = renew_context_attachment_draft(attachment);
  data_transfer.effectAllowed = "copy";
  data_transfer.setData(
    AGENT_CONTEXT_ATTACHMENT_MIME,
    JSON.stringify(renewed_attachment),
  );
  data_transfer.setData(
    "text/plain",
    renewed_attachment.snapshot_text ?? renewed_attachment.label,
  );
}

export function read_context_attachment_drag_data(
  data_transfer: DataTransfer,
): AgentContextAttachmentDraft | null {
  return parse_context_attachment(
    data_transfer.getData(AGENT_CONTEXT_ATTACHMENT_MIME),
  );
}

export function parse_context_attachment(
  encoded: string,
): AgentContextAttachmentDraft | null {
  if (!encoded) return null;
  try {
    const value = JSON.parse(encoded) as Record<string, unknown>;
    if (
      typeof value.draft_id !== "string" ||
      !is_attachment_kind(value.kind) ||
      typeof value.asset_id !== "string" ||
      typeof value.label !== "string"
    ) {
      return null;
    }
    const attachment: AgentContextAttachmentDraft = {
      draft_id: value.draft_id,
      kind: value.kind,
      asset_id: value.asset_id,
      label: value.label,
      reference_id:
        typeof value.reference_id === "string" ? value.reference_id : undefined,
      version_id:
        typeof value.version_id === "string" ? value.version_id : undefined,
      start_seconds:
        typeof value.start_seconds === "number"
          ? value.start_seconds
          : undefined,
      end_seconds:
        typeof value.end_seconds === "number" ? value.end_seconds : undefined,
      snapshot_text:
        typeof value.snapshot_text === "string"
          ? value.snapshot_text
          : undefined,
      selection_start:
        typeof value.selection_start === "number"
          ? value.selection_start
          : undefined,
      selection_end:
        typeof value.selection_end === "number"
          ? value.selection_end
          : undefined,
    };
    if (!valid_context_attachment(attachment)) return null;
    return attachment;
  } catch {
    return null;
  }
}

function valid_context_attachment(attachment: AgentContextAttachmentDraft) {
  if (!attachment.asset_id.trim() || !attachment.label.trim()) return false;
  if (attachment.kind === "time_range") {
    return (
      typeof attachment.start_seconds === "number" &&
      typeof attachment.end_seconds === "number" &&
      attachment.start_seconds >= 0 &&
      attachment.end_seconds > attachment.start_seconds
    );
  }
  return Boolean(attachment.snapshot_text?.trim());
}

export function agent_scope_key(
  agent_id: string,
  asset_id: string,
  context: Record<string, unknown>,
): string {
  return JSON.stringify({
    agent_id,
    asset_id,
    context: canonical_value(context),
  });
}

export function session_context_matches_scope(
  session_context: Record<string, unknown>,
  scope_key: string,
  context: Record<string, unknown>,
): boolean {
  if (session_context.scope_key === scope_key) return true;
  if (typeof session_context.scope_key === "string") return false;
  return (
    JSON.stringify(canonical_value(session_context)) ===
    JSON.stringify(canonical_value(context))
  );
}

export async function materialize_context_attachments(
  drafts: AgentContextAttachmentDraft[],
): Promise<AgentContextAttachment[]> {
  return Promise.all(
    drafts.map(async ({ draft_id, ...draft }) => {
      if (!draft_id) throw new Error("上下文附件缺少临时标识");
      const content_digest = draft.snapshot_text
        ? await sha256_hex(draft.snapshot_text)
        : undefined;
      if (draft.kind !== "time_range" && !content_digest) {
        throw new Error("文本附件缺少可校验的内容快照");
      }
      return {
        ...draft,
        attachment_id: `attachment-${uuid7().replaceAll("-", "")}`,
        content_digest,
      };
    }),
  );
}

async function sha256_hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function canonical_value(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical_value);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical_value(item)]),
  );
}

function is_attachment_kind(
  value: unknown,
): value is AgentContextAttachmentDraft["kind"] {
  return (
    value === "summary_selection" ||
    value === "transcript_selection" ||
    value === "time_range"
  );
}
