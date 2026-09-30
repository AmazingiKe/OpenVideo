import { STORY_ASSETS } from "@/features/library/library_story_fixtures";
import type { MediaSegment, VisualAnalysisStatus } from "@/shared/types";

export function create_coverage_segment(
  status: VisualAnalysisStatus | undefined,
  index = 0,
): MediaSegment {
  return {
    segment_id: `segment-019c00000000700080000000000000${index.toString(16).padStart(2, "0")}`,
    asset_id: STORY_ASSETS[0].asset_id,
    start_seconds: index * 10,
    end_seconds: (index + 1) * 10,
    title: `雾效节点步骤 ${index + 1}`,
    detailed_summary: "字幕记录的操作说明",
    transcript_text: "连接材质节点并调整雾效",
    speaker_name: null,
    key_frame_paths:
      status === "sampled" ? ["frames/first.jpg", "frames/second.jpg"] : [],
    visual_description: status === "sampled" ? "可见的节点画面" : null,
    visual_analysis_status: status,
    ocr_text: null,
    formula_latex: [],
    marker_ids: [],
    tags: [],
  };
}

export const MIXED_VISUAL_COVERAGE_SEGMENTS = [
  create_coverage_segment("sampled", 0),
  create_coverage_segment("failed", 1),
  create_coverage_segment("skipped", 2),
  create_coverage_segment("no_frames", 3),
  create_coverage_segment("not_requested", 4),
  create_coverage_segment(undefined, 5),
];
