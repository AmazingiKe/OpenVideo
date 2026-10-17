import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

  it("separates queue time from running time and freezes completed duration", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T10:02:00Z"));
    const task: TaskRecord = {
      ...task_record("running", false),
      task_type: "transcription",
      progress_known: false,
      stage: "transcribing",
    };
    try {
      const { rerender, unmount } = render(
        <TaskCenter open tasks={[task]} on_retry={vi.fn()} />,
      );
      expect(screen.getByText("已等待 02:00")).toBeVisible();
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
      expect(screen.getByText("当前阶段暂不提供百分比")).toBeVisible();
      const started = { ...task, started_at: "2026-08-29T10:01:00Z" };
      rerender(<TaskCenter open tasks={[started]} on_retry={vi.fn()} />);
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.getByText("已运行 01:01")).toBeVisible();
      rerender(
        <TaskCenter
          open
          tasks={[{ ...started, progress_known: true }]}
          on_retry={vi.fn()}
        />,
      );
      expect(screen.getByRole("progressbar")).toBeVisible();
      rerender(
        <TaskCenter
          open
          tasks={[
            {
              ...started,
              stage: "complete",
              updated_at: "2026-08-29T10:02:01Z",
            },
          ]}
          on_retry={vi.fn()}
        />,
      );
      act(() => vi.advanceTimersByTime(5000));
      expect(screen.getByText("已运行 01:01")).toBeVisible();
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers retrying a failed stop without allowing download resumption or deletion", async () => {
    const on_pause = vi.fn().mockResolvedValue(undefined);
    render(
      <TaskCenter
        open
        tasks={[
          {
            ...task_record("pausing", false),
            task_type: "download",
            pause_available: true,
            error_message: "进程尚未退出",
            retry_available: false,
            delete_available: false,
          },
        ]}
        on_retry={vi.fn()}
        on_pause={on_pause}
        on_delete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "重试停止" }));
    await waitFor(() => expect(on_pause).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("button", { name: "继续下载" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "删除任务" }),
    ).not.toBeInTheDocument();
  });

  it("stops a transcription, disables repeated stops, and shows request failures", async () => {
    let reject_stop!: (error: Error) => void;
    const on_cancel = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          reject_stop = reject;
        }),
    );
    const task: TaskRecord = {
      ...task_record("running", false),
      task_type: "transcription",
      stage: "transcribing",
      cancel_available: true,
    };
    const { rerender } = render(
      <TaskCenter
        open
        tasks={[task]}
        on_retry={vi.fn()}
        on_cancel={on_cancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "停止转写" }));
    expect(screen.getByRole("button", { name: "停止转写" })).toBeDisabled();
    expect(on_cancel).toHaveBeenCalledOnce();
    reject_stop(new Error("停止请求未送达"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "停止请求未送达",
    );
    expect(screen.getByRole("button", { name: "停止转写" })).toBeEnabled();
    rerender(
      <TaskCenter
        open
        tasks={[{ ...task, stage: "cancelling", cancel_available: false }]}
        on_retry={vi.fn()}
        on_cancel={on_cancel}
      />,
    );
    expect(screen.getByRole("button", { name: "正在停止…" })).toBeDisabled();
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
