import { format_time } from "@/shared/format";
import type { MarkerImportance, MediaMarker } from "@/shared/types";

export function format_marker_importance(importance: MarkerImportance): string {
  return importance === 0 ? "未评分" : "★".repeat(importance);
}

export function format_marker_label(
  marker: Pick<MediaMarker, "start_seconds" | "importance">,
): string {
  return `${format_marker_importance(marker.importance)} · ${format_time(marker.start_seconds)}`;
}
