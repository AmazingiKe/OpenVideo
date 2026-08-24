import type { AnalysisStrategy } from "./types";

export const MARKER_RANGE_MIN_SECONDS = 0;
export const MARKER_RANGE_MAX_SECONDS = 120;
export const MARKER_RANGE_STEP_SECONDS = 5;

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
