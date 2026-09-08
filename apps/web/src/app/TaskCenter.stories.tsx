import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import { TaskCenter } from "@/app/TaskCenter";
import type { TaskRecord } from "@/features/workbench/tasks";

const TASKS: TaskRecord[] = [
  {
    task_id: "run-019c012345677abc8123456789abcdef",
    task_type: "agent",
    stage: "running",
    message: "助手正在处理",
    progress_percent: 50,
    error_message: null,
    created_at: "2026-08-29T10:00:00Z",
    name: "分析角色动作",
  },
  {
    task_id: "run-019c012345677abc8123456789abcdee",
    task_type: "agent",
    stage: "interrupted",
    message: "应用退出时任务中断",
    progress_percent: 100,
    error_message: null,
    created_at: "2026-08-29T09:00:00Z",
    name: "整理镜头标记",
    retry_available: true,
  },
  {
    task_id: "job-019c012345677abc8123456789abcdef",
    task_type: "download",
    stage: "complete",
    message: "下载完成",
    progress_percent: 100,
    error_message: null,
    created_at: "2026-08-29T08:00:00Z",
    name: "产品演示视频",
  },
];

const meta = {
  title: "App/TaskCenter",
  component: TaskCenter,
  args: {
    tasks: TASKS,
    on_retry: async () => undefined,
  },
} satisfies Meta<typeof TaskCenter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveAndInterrupted: Story = {};

export const Empty: Story = {
  args: { tasks: [] },
};

export const DownloadStates: Story = {
  args: {
    open: true,
    tasks: ["submitting", "downloading", "pausing", "paused", "failed"].map(
      (stage, index) => ({
        ...TASKS[2],
        task_id: `${TASKS[2].task_id.slice(0, -1)}${index}`,
        name: `视频课程 ${index + 1}`,
        stage,
        message:
          stage === "failed"
            ? "下载失败，可重新开始"
            : stage === "paused"
              ? "已暂停，保留续传分片"
              : "已加入下载队列",
        progress_percent: 25,
        progress_known: stage !== "submitting",
        error_message: stage === "failed" ? "网络连接中断" : null,
        retry_available: stage === "failed" || stage === "paused",
        pause_available: stage === "downloading",
        delete_available: stage === "failed" || stage === "paused",
      }),
    ),
    on_retry: fn(async () => undefined),
    on_pause: fn(async () => undefined),
    on_delete: fn(async () => undefined),
  },
  play: async ({ canvasElement, args }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await body.findByRole("button", { name: "暂停下载" }),
    );
    await expect(args.on_pause).toHaveBeenCalledWith(args.tasks[1].task_id);
    await userEvent.click(body.getByRole("button", { name: "继续下载" }));
    await expect(args.on_retry).toHaveBeenCalledWith(args.tasks[3].task_id);
    await userEvent.click(body.getByRole("button", { name: "重新开始" }));
    await expect(args.on_retry).toHaveBeenCalledWith(args.tasks[4].task_id);
    const failed_task = body.getByText("网络连接中断").closest("li")!;
    await userEvent.click(
      within(failed_task).getByRole("button", { name: "删除任务" }),
    );
    await expect(args.on_delete).toHaveBeenCalledWith(args.tasks[4].task_id);
  },
};
