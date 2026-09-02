import type { ScrubPreviewMetrics } from "./use_scrub_frame_preview";

const PERFORMANCE_ENTRY_NAME = "openvideo.scrub-preview";
const MAX_PERFORMANCE_ENTRIES = 100;

export function record_scrub_preview_metrics(metrics: ScrubPreviewMetrics) {
  if (
    performance.getEntriesByName(PERFORMANCE_ENTRY_NAME).length >=
    MAX_PERFORMANCE_ENTRIES
  ) {
    performance.clearMeasures(PERFORMANCE_ENTRY_NAME);
  }
  const duration = Math.max(0, metrics.decode_milliseconds);
  performance.measure(PERFORMANCE_ENTRY_NAME, {
    start: Math.max(0, performance.now() - duration),
    duration,
    detail: metrics,
  });
}
