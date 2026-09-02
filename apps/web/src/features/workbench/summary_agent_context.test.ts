import { describe, expect, it } from "vitest";

import type { SummaryDocument } from "@/shared/types";
import { summary_agent_focus } from "./summary_agent_context";

describe("summary agent context", () => {
  it("keeps the video scope while exposing the focused chapter selection", () => {
    const documents = [
      document("document-1", "目录"),
      document("document-2", "透视"),
    ];

    expect(
      summary_agent_focus(documents, documents[1]!, {
        start: 4,
        end: 10,
        text: "透视投影",
      }),
    ).toMatchObject({
      workspace: "summary",
      surface: "summary_selection",
      label: "总结选区 · 第 2 章 · 透视",
      document: { document_id: "document-2", index: 2 },
      selection_start: 4,
      selection_end: 10,
    });
  });
});

function document(document_id: string, title: string): SummaryDocument {
  return {
    document_id,
    asset_id: "asset-1",
    parent_document_id: null,
    title,
    markdown: `# ${title}`,
    relative_path: "summary.md",
    content_digest: "digest",
    position: 0,
    revision: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}
