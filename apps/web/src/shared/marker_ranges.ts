import type { AnalysisStrategy, MediaMarker } from "@/shared/types";

export const MARKER_RANGE_MIN_SECONDS = 0;
export const MARKER_RANGE_MAX_SECONDS = 120;
export const MARKER_RANGE_STEP_SECONDS = 5;

export type EffectiveMarkerRanges = {
  before_seconds: number;
  after_seconds: number;
};

export function effective_marker_ranges(
  marker: Pick<
    MediaMarker,
    "marker_range_before_seconds" | "marker_range_after_seconds"
  >,
  strategy: Pick<
    AnalysisStrategy,
    "marker_range_before_seconds" | "marker_range_after_seconds"
  >,
): EffectiveMarkerRanges {
  return {
    before_seconds:
      marker.marker_range_before_seconds ??
      strategy.marker_range_before_seconds,
    after_seconds:
      marker.marker_range_after_seconds ?? strategy.marker_range_after_seconds,
  };
}
