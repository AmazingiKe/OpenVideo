import type { Meta, StoryObj } from "@storybook/react-vite";

import { DownloadActivity } from "@/features/downloads/DownloadActivity";

const meta = {
  title: "Downloads/DownloadActivity",
  component: DownloadActivity,
  args: { tasks: [] },
} satisfies Meta<typeof DownloadActivity>;

export default meta;
type Story = StoryObj<typeof meta>;

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
      },
      {
        task_id: "job-0198d12345677890abcdef1234567891",
        task_type: "download",
        stage: "failed",
        message: "下载失败",
        progress_percent: 12,
        error_message: "远程服务器拒绝了请求",
        created_at: "2026-08-25T08:21:03Z",
      },
    ],
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
