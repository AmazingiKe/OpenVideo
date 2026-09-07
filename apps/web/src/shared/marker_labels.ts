import { format_time } from "@/shared/format";
import type { MarkerImportance, MediaMarker } from "@/shared/types";

export const MARKER_IMPORTANCE_VALUES: MarkerImportance[] = [0, 1, 2, 3, 4, 5];

export function format_marker_importance(importance: MarkerImportance): string {
  return importance === 0 ? "未评分" : "★".repeat(importance);
}

export function format_marker_label(
  marker: Pick<MediaMarker, "start_seconds" | "importance" | "content">,
): string {
  const content = marker.content.trim();
  const label = [content];
  if (marker.importance || !content) {
    label.push(format_marker_importance(marker.importance));
  }
  label.push(format_time(marker.start_seconds));
  return label.filter(Boolean).join(" · ");
}
