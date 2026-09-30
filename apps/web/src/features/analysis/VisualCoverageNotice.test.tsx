import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { visual_analysis_coverage } from "@/shared/analysis";
import { VisualCoverageNotice } from "./VisualCoverageNotice";
import {
  create_coverage_segment,
  MIXED_VISUAL_COVERAGE_SEGMENTS,
} from "./visual_coverage_story_fixtures";

describe("VisualCoverageNotice", () => {
  it("does not report analysis for a video without saved chapters", () => {
    render(<VisualCoverageNotice segments={[]} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("counts saved sampling outcomes separately and keeps the limitation visible", () => {
    expect(visual_analysis_coverage(MIXED_VISUAL_COVERAGE_SEGMENTS)).toEqual({
      total_segments: 6,
      sampled_segments: 1,
      sampled_frame_count: 2,
      skipped_segments: 1,
      no_frames_segments: 1,
      failed_segments: 1,
      not_requested_segments: 1,
      unknown_segments: 1,
    });
    render(<VisualCoverageNotice segments={MIXED_VISUAL_COVERAGE_SEGMENTS} />);
    const notice = screen.getByRole("status", { name: "画面分析覆盖" });
    expect(notice).toHaveTextContent("已保存章节：视觉采样 1 / 6 章 · 2 帧");
    for (const label of [
      "视觉分析失败",
      "未提取到关键帧",
      "按策略跳过",
      "未请求视觉模型",
      "视觉状态未知",
    ]) {
      expect(notice).toHaveTextContent(`${label} 1 章`);
    }
    expect(notice).toHaveTextContent("不代表逐帧理解");
    expect(notice).toHaveAttribute("aria-live", "polite");
  });

  it("never infers visual sampling from legacy frames or descriptions", () => {
    const segment = {
      ...create_coverage_segment(undefined),
      key_frame_paths: ["legacy.jpg"],
      visual_description: "旧版本的画面描述",
    };
    render(<VisualCoverageNotice segments={[segment]} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "视觉采样 0 / 1 章 · 0 帧",
    );
    expect(screen.getByRole("status")).toHaveTextContent("视觉状态未知 1 章");
  });

  it("updates saved results without retaining stale failure counts", () => {
    const view = render(
      <VisualCoverageNotice segments={MIXED_VISUAL_COVERAGE_SEGMENTS} />,
    );
    view.rerender(
      <VisualCoverageNotice segments={[create_coverage_segment("sampled")]} />,
    );
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("视觉采样 1 / 1 章 · 2 帧");
    expect(notice).not.toHaveTextContent("视觉分析失败");
    expect(notice).toHaveTextContent("不代表逐帧理解");
  });
});
