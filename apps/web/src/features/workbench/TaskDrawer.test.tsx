import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TaskDrawer } from "./TaskDrawer";


describe("TaskDrawer", () => {
  it("keeps completed and failed task states in the task record", () => {
    render(
      <TaskDrawer
        open
        task_records={[
          {
            task_id: "job-complete",
            task_type: "download",
            stage: "complete",
            message: "下载完成",
            progress_percent: 100,
            error_message: null,
          },
          {
            task_id: "analysis-failed",
            task_type: "analysis",
            stage: "failed",
            message: "分析失败",
            progress_percent: 60,
            error_message: "视觉模型不可用",
          },
        ]}
        on_toggle={vi.fn()}
      />,
    );

    expect(screen.getByText(/下载完成/)).toBeInTheDocument();
    expect(screen.getByText(/分析失败/)).toBeInTheDocument();
    expect(screen.getByText("视觉模型不可用")).toBeInTheDocument();
  });
});
