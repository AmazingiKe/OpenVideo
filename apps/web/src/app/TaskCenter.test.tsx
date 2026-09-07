import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TaskCenter } from "@/app/TaskCenter";
import type { TaskRecord } from "@/features/workbench/tasks";

describe("TaskCenter", () => {
  it("shows active tasks and retries an interrupted agent run", async () => {
    const on_retry = vi.fn().mockResolvedValue(undefined);
    render(
      <TaskCenter
        tasks={[
          task_record("running", false),
          task_record("interrupted", true),
        ]}
        on_retry={on_retry}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "任务中心，1 个进行中" }),
    );
    expect(screen.getByText("运行中")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "从头重试" }));

    await waitFor(() =>
      expect(on_retry).toHaveBeenCalledWith(
        "run-019c012345677abc8123456789abcdef",
      ),
    );
  });

  it("does not invent a percentage for an unknown-duration index stage", () => {
    render(
      <TaskCenter
        tasks={[
          {
            task_id: "index-task-019c012345677abc8123456789abcdef",
            task_type: "index",
            stage: "projecting",
            message: "正在计算语义投影，耗时暂不可估计",
            progress_percent: 0,
            progress_known: false,
            error_message: null,
            created_at: "2026-08-29T10:00:00Z",
            name: "资料库证据索引",
          },
        ]}
        on_retry={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "任务中心，1 个进行中" }),
    );
    expect(screen.getByText("计算投影")).toBeVisible();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});

function task_record(stage: string, retry_available: boolean): TaskRecord {
  return {
    task_id:
      stage === "running"
        ? "run-019c012345677abc8123456789abcdee"
        : "run-019c012345677abc8123456789abcdef",
    task_type: "agent",
    stage,
    message: stage === "running" ? "助手正在处理" : "应用退出时任务中断",
    progress_percent: stage === "running" ? 50 : 100,
    error_message: null,
    created_at:
      stage === "running" ? "2026-08-29T10:00:00Z" : "2026-08-29T09:00:00Z",
    name: stage === "running" ? "分析角色动作" : "整理镜头标记",
    retry_available,
  };
}
