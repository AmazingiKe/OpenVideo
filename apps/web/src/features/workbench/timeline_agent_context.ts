import type { AgentContextAttachmentDraft } from "@/components/agent_context";
import type {
  AgentFocusContext,
  FocusSelection,
  MediaSegment,
  Transcript,
} from "@/shared/types";

type TimelineAgentFocusOptions = {
  playhead_seconds: number;
  segments: MediaSegment[];
  selected_marker_ids: string[];
  selected_transcript_indices: number[];
  focus_selection: FocusSelection | null;
};

export function timeline_agent_focus({
  playhead_seconds,
  segments,
  selected_marker_ids,
  selected_transcript_indices,
  focus_selection,
}: TimelineAgentFocusOptions): AgentFocusContext {
  const chapters = segments
    .filter((segment) => segment.marker_ids.length === 0)
    .sort((left, right) => left.start_seconds - right.start_seconds);
  const chapter_index = chapters.findIndex(
    (segment, index) =>
      segment.start_seconds <= playhead_seconds &&
      (playhead_seconds < segment.end_seconds ||
        (index === chapters.length - 1 &&
          playhead_seconds === segment.end_seconds)),
  );
  const focused_chapter = chapters[chapter_index];
  const chapter = focused_chapter
    ? {
        segment_id: focused_chapter.segment_id,
        index: chapter_index + 1,
        title: focused_chapter.title,
        start_seconds: focused_chapter.start_seconds,
        end_seconds: focused_chapter.end_seconds,
      }
    : undefined;
  const time_range =
    focus_selection &&
    focus_selection.in_seconds !== null &&
    focus_selection.out_seconds !== null
      ? {
          selection_id: focus_selection.selection_id,
          start_seconds: focus_selection.in_seconds,
          end_seconds: focus_selection.out_seconds,
          revision: focus_selection.revision,
        }
      : undefined;

  let surface: AgentFocusContext["surface"] = "timeline";
  let surface_label = "时间线";
  if (selected_transcript_indices.length > 0) {
    surface = "transcript";
    surface_label = "转写面板";
  } else if (selected_marker_ids.length > 0) {
    surface = "markers";
    surface_label = "标记面板";
  } else if (time_range) {
    surface = "focus_range";
    surface_label = "时间线焦点";
  }

  return {
    workspace: "markers",
    surface,
    label: chapter
      ? `${surface_label} · 第 ${chapter.index} 章`
      : surface_label,
    playhead_seconds,
    chapter,
    time_range,
    selected_marker_ids: [...selected_marker_ids],
    selected_transcript_indices: [...selected_transcript_indices],
  };
}

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
