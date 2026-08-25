import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";

import { DownloadActivity } from "@/features/downloads/DownloadActivity";

const meta = {
  title: "Downloads/DownloadActivity",
  component: DownloadActivity,
  args: {
    tasks: [],
    retrying_task_id: null,
    on_retry: () => undefined,
  },
} satisfies Meta<typeof DownloadActivity>;

export default meta;
type Story = StoryObj<typeof meta>;

const FAILED_TASK_ID = "job-0198d12345677890abcdef1234567891";

export const Empty: Story = {};

export const Running: Story = {
  args: {
    tasks: [
      {
        task_id: "job-0198d12345677890abcdef1234567890",
        task_type: "download",
        stage: "downloading",
        message: "正在下载视频流",
        progress_percent: 48,
        error_message: null,
        created_at: "2026-08-25T08:24:16Z",
        name: "Blender 角色绑定完整教程",
        events: [
          {
            event_id: "event-0198d12345677890abcdef1234567892",
            job_id: "job-0198d12345677890abcdef1234567890",
            stage: "reading_metadata",
            progress_percent: 1,
            message: "已识别视频：Blender 角色绑定完整教程",
            error_message: null,
            created_at: "2026-08-25T08:24:18Z",
          },
          {
            event_id: "event-0198d12345677890abcdef1234567893",
            job_id: "job-0198d12345677890abcdef1234567890",
            stage: "downloading",
            progress_percent: 2,
            message: "正在下载视频和音频",
            error_message: null,
            created_at: "2026-08-25T08:24:20Z",
          },
        ],
      },
      {
        task_id: FAILED_TASK_ID,
        task_type: "download",
        stage: "failed",
        message: "下载失败",
        progress_percent: 12,
        error_message: "远程服务器拒绝了请求",
        created_at: "2026-08-25T08:21:03Z",
        name: "Maya 灯光渲染案例",
        events: [
          {
            event_id: "event-0198d12345677890abcdef1234567894",
            job_id: "job-0198d12345677890abcdef1234567891",
            stage: "failed",
            progress_percent: 12,
            message: "下载失败",
            error_message: "远程服务器拒绝了请求",
            created_at: "2026-08-25T08:21:16Z",
          },
        ],
      },
    ],
  },
};

export const Retrying: Story = {
  ...Running,
  args: {
    ...Running.args,
    retrying_task_id: FAILED_TASK_ID,
  },
};

export const Detailed: Story = {
  ...Running,
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: /Blender 角色绑定完整教程/,
      }),
    );
  },
};

export const Narrow: Story = {
  ...Detailed,
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
};

export const Dark: Story = {
  ...Running,
  decorators: [
    (Story) => (
      <div className="dark min-h-screen bg-background p-4 text-foreground">
        <Story />
      </div>
    ),
  ],
};
