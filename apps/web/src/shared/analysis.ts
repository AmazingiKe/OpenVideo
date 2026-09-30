import type {
  AnalysisStrategy,
  MediaSegment,
  VisualAnalysisCoverage,
} from "./types";

export const DEFAULT_ANALYSIS_STRATEGY: AnalysisStrategy = {
  preset: "course_notes",
  weights: {
    core_concepts: 90,
    formula_derivation: 65,
    case_demonstration: 60,
    questions_conclusions: 80,
    visual_content: 55,
    user_markers: 100,
  },
  depth: "balanced",
  marker_range_before_seconds: 10,
  marker_range_after_seconds: 20,
};

export function visual_analysis_coverage(
  segments: MediaSegment[],
): VisualAnalysisCoverage {
  const coverage: VisualAnalysisCoverage = {
    total_segments: segments.length,
    sampled_segments: 0,
    sampled_frame_count: 0,
    skipped_segments: 0,
    no_frames_segments: 0,
    failed_segments: 0,
    not_requested_segments: 0,
    unknown_segments: 0,
  };
  for (const segment of segments) {
    switch (segment.visual_analysis_status) {
      case "sampled":
        coverage.sampled_segments += 1;
        coverage.sampled_frame_count += segment.key_frame_paths.length;
        break;
      case "failed":
        coverage.failed_segments += 1;
        break;
      case "no_frames":
        coverage.no_frames_segments += 1;
        break;
      case "skipped":
        coverage.skipped_segments += 1;
        break;
      case "not_requested":
        coverage.not_requested_segments += 1;
        break;
      default:
        coverage.unknown_segments += 1;
    }
  }
  return coverage;
}
