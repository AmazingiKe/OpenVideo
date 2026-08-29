import type { AgentContextAttachmentDraft } from "@/components/agent_context";
import type { FocusSelection, Transcript } from "@/shared/types";

export function focus_context_attachment(
  selection: FocusSelection | null,
): AgentContextAttachmentDraft | null {
  if (
    !selection ||
    selection.in_seconds === null ||
    selection.out_seconds === null
  ) {
    return null;
  }
  return {
    draft_id: `${selection.selection_id}-${selection.revision}`,
    kind: "time_range",
    asset_id: selection.asset_id,
    label: "时间线理解范围",
    reference_id: selection.selection_id,
    start_seconds: selection.in_seconds,
    end_seconds: selection.out_seconds,
  };
}

export function transcript_context_attachment(
  asset_id: string | null,
  transcript: Transcript | null,
  segment_indices: number[],
): AgentContextAttachmentDraft | null {
  if (!asset_id || !transcript || segment_indices.length === 0) return null;
  const selected_segments = [...new Set(segment_indices)]
    .sort((left, right) => left - right)
    .flatMap((index) => {
      const segment = transcript.segments[index];
      return segment ? [{ index, segment }] : [];
    });
  if (selected_segments.length === 0) return null;
  const first = selected_segments[0];
  const last = selected_segments.at(-1);
  if (!first || !last) return null;
  return {
    draft_id: `transcript-${transcript.created_at}-${selected_segments
      .map(({ index }) => index)
      .join("-")}`,
    kind: "transcript_selection",
    asset_id,
    label: `字幕选区（${selected_segments.length} 条）`,
    reference_id: transcript.created_at,
    start_seconds: first.segment.start_seconds,
    end_seconds: last.segment.end_seconds,
    snapshot_text: selected_segments
      .map(({ segment }) => segment.text.trim())
      .filter(Boolean)
      .join("\n"),
    selection_start: first.index,
    selection_end: last.index,
  };
}
