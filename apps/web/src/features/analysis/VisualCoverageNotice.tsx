import { CircleAlert, Info } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { visual_analysis_coverage } from "@/shared/analysis";
import type { MediaSegment } from "@/shared/types";

export function VisualCoverageNotice({
  segments,
}: {
  segments: MediaSegment[];
}) {
  if (!segments.length) return null;
  const coverage = visual_analysis_coverage(segments);
  const has_failures =
    coverage.failed_segments > 0 || coverage.no_frames_segments > 0;
  const details = [
    [coverage.failed_segments, "视觉分析失败"],
    [coverage.no_frames_segments, "未提取到关键帧"],
    [coverage.skipped_segments, "按策略跳过"],
    [coverage.not_requested_segments, "未请求视觉模型"],
    [coverage.unknown_segments, "视觉状态未知"],
  ] as const;

  return (
    <Alert
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label="画面分析覆盖"
      variant={has_failures ? "destructive" : "default"}
    >
      {has_failures ? (
        <CircleAlert aria-hidden="true" />
      ) : (
        <Info aria-hidden="true" />
      )}
      <AlertTitle>
        已保存章节：视觉采样 {coverage.sampled_segments} /{" "}
        {coverage.total_segments} 章 · {coverage.sampled_frame_count} 帧
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-1">
        {details.some(([count]) => count > 0) ? (
          <span>
            {details
              .filter(([count]) => count > 0)
              .map(([count, label]) => `${label} ${count} 章`)
              .join(" · ")}
          </span>
        ) : null}
        <span>
          关键帧采样不代表逐帧理解；未展示的节点连接、参数和操作仍需核实。
        </span>
      </AlertDescription>
    </Alert>
  );
}
