import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SummaryIllustrationJob } from "@/shared/types";
import { SummaryIllustrationProgress } from "./SummaryIllustrationProgress";

const JOB: SummaryIllustrationJob = {
  job_id: "summary-illustration-job-0198dbf912347abc8123456789abcdef",
  asset_id: "0198dbf9-1234-7abc-8123-456789abcdef",
  version_id: "summary-version-0198dbf912347abc8123456789abcdef",
  planning_model_id: "model-0198dbf912347abc8123456789abcdef",
  vision_model_id: "model-0198dbf912347abc8123456789abcdee",
  stage: "validating",
  progress_percent: 60,
  message: "正在验证候选画面",
  slots: [
    {
      slot_id: "illustration-slot-0198dbf912347abc8123456789abcdef",
      document_id: "document-0198dbf912347abc8123456789abcdef",
      heading_path: ["材质设置"],
      target_excerpt: "调整粗糙度。",
      retrieval_query: "粗糙度",
      caption: "粗糙度参数位置",
      status: "validating",
      candidate_times: [12, 15, 18],
      selected_time: null,
      confidence: null,
      source_excerpt: "调整右侧的粗糙度。",
      source_types: ["transcript"],
      media_id: null,
      message: "正在验证画面是否真正支持笔记",
    },
  ],
  inserted_count: 0,
  skipped_count: 0,
  error_message: null,
  created_at: "2026-08-31T10:00:00Z",
  updated_at: "2026-08-31T10:00:05Z",
};

describe("SummaryIllustrationProgress", () => {
  it("keeps detailed candidate states folded by default", () => {
    const { container } = render(
      <SummaryIllustrationProgress
        job={JOB}
        now={Date.parse("2026-08-31T10:00:08Z")}
      />,
    );

    expect(screen.getByText("自动配图")).toBeInTheDocument();
    expect(screen.getByText("8 秒")).toBeInTheDocument();
    expect(container.querySelector("details")).not.toHaveAttribute("open");
  });

  it("reveals per-slot evidence state with keyboard-compatible details", () => {
    const { container } = render(<SummaryIllustrationProgress job={JOB} />);

    fireEvent.click(container.querySelector("summary")!);

    expect(container.querySelector("details")).toHaveAttribute("open");
    expect(screen.getByText("粗糙度参数位置")).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "自动配图进度 60%" }),
    ).toBeInTheDocument();
  });
});
