import type { Meta, StoryObj } from "@storybook/react-vite";

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
    resume_available: true,
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
    on_resume: async () => undefined,
  },
} satisfies Meta<typeof TaskCenter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveAndInterrupted: Story = {};

export const Empty: Story = {
  args: { tasks: [] },
};
