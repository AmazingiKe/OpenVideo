import type { MarkdownSelection } from "@/components/MarkdownEditor";
import type { AgentFocusContext, SummaryDocument } from "@/shared/types";

export function summary_agent_focus(
  documents: SummaryDocument[],
  selected_document: SummaryDocument,
  selection: MarkdownSelection | null,
): AgentFocusContext {
  const document_index = Math.max(
    1,
    documents.findIndex(
      (document) => document.document_id === selected_document.document_id,
    ) + 1,
  );
  const surface = selection ? "summary_selection" : "summary_document";
  const surface_label = selection ? "总结选区" : "总结文档";

  return {
    workspace: "summary",
    surface,
    label: `${surface_label} · 第 ${document_index} 章 · ${selected_document.title}`,
    document: {
      document_id: selected_document.document_id,
      parent_document_id: selected_document.parent_document_id,
      index: document_index,
      title: selected_document.title,
      revision: selected_document.revision,
    },
    selected_marker_ids: [],
    selected_transcript_indices: [],
    selection_start: selection?.start,
    selection_end: selection?.end,
  };
}
