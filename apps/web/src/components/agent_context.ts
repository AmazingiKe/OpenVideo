import { uuid7 } from "@/shared/identifiers";
import type { AgentContextAttachment } from "@/shared/types";

export type AgentContextAttachmentDraft = Omit<
  AgentContextAttachment,
  "attachment_id" | "content_digest"
> & {
  draft_id: string;
};

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
