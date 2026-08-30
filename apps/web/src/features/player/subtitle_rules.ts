import type { AgentEvidenceRange, TranscriptSegment } from "@/shared/types";

export function active_subtitle_segment(
  segments: TranscriptSegment[],
  current_time: number,
): TranscriptSegment | null {
  return (
    segments.find(
      (segment) =>
        segment.start_seconds <= current_time &&
        current_time < segment.end_seconds,
    ) ?? null
  );
}

export function subtitle_is_evidence(
  segment: TranscriptSegment,
  evidence_range: AgentEvidenceRange,
) {
  return (
    segment.start_seconds <= evidence_range.end_seconds &&
    evidence_range.start_seconds <= segment.end_seconds
  );
}
