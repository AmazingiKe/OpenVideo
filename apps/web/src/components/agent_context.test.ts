import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  agent_scope_key,
  materialize_context_attachments,
  parse_context_attachment,
  session_context_matches_scope,
} from "./agent_context";

describe("agent context", () => {
  beforeAll(() => {
    vi.stubGlobal("crypto", webcrypto);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("builds a stable scope key and rejects a different document version", () => {
    const left = agent_scope_key("summary", "asset-1", {
      document_id: "document-1",
      version_id: "version-2",
    });
    const right = agent_scope_key("summary", "asset-1", {
      version_id: "version-2",
      document_id: "document-1",
    });

    expect(left).toBe(right);
    expect(
      session_context_matches_scope(
        { document_id: "document-1", version_id: "version-1" },
        left,
        { document_id: "document-1", version_id: "version-2" },
      ),
    ).toBe(false);
  });

  it("materializes text attachments with UUIDv7 and a SHA-256 digest", async () => {
    const [attachment] = await materialize_context_attachments([
      {
        draft_id: "selection-1",
        kind: "summary_selection",
        asset_id: "asset-1",
        label: "总结选区",
        snapshot_text: "准确性是第一公民",
      },
    ]);

    expect(attachment?.attachment_id).toMatch(/^attachment-[0-9a-f]{32}$/);
    expect(attachment?.content_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps a time range as a reference without inventing a digest", async () => {
    const [attachment] = await materialize_context_attachments([
      {
        draft_id: "range-1",
        kind: "time_range",
        asset_id: "asset-1",
        label: "时间范围",
        reference_id: "focus-selection-1",
        start_seconds: 12,
        end_seconds: 24,
      },
    ]);

    expect(attachment?.content_digest).toBeUndefined();
  });

  it("rejects incomplete or reversed attachments at the drop boundary", () => {
    expect(
      parse_context_attachment(
        JSON.stringify({
          draft_id: "range-1",
          kind: "time_range",
          asset_id: "asset-1",
          label: "时间范围",
          start_seconds: 24,
          end_seconds: 12,
        }),
      ),
    ).toBeNull();
    expect(
      parse_context_attachment(
        JSON.stringify({
          draft_id: "selection-1",
          kind: "summary_selection",
          asset_id: "asset-1",
          label: "总结选区",
          snapshot_text: " ",
        }),
      ),
    ).toBeNull();
  });
});
