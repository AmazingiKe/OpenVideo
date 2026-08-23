import type { Meta, StoryObj } from "@storybook/react-vite";

import { TranscriptionModelDownloadAction } from "./TranscriptionModelDownloadAction";

const meta = {
  title: "Settings/TranscriptionModelDownloadAction",
  component: TranscriptionModelDownloadAction,
  args: {
    model: {
      engine: "faster-whisper",
      model: "large-v3-turbo",
      name: "Whisper Large V3 Turbo",
      description: "高精度与推理速度的推荐平衡方案。",
      accuracy: "高",
      speed: "较快",
      languages: ["多语言", "粤语"],
      repository: "dropbox-dash/faster-whisper-large-v3-turbo",
      recommended: true,
      integration_status: "available",
      installation_status: "not_installed",
      download_job: null,
    },
    on_change: () => undefined,
  },
  decorators: [
    (StoryComponent) => (
      <div className="w-72 p-8">
        <StoryComponent />
      </div>
    ),
  ],
} satisfies Meta<typeof TranscriptionModelDownloadAction>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Download: Story = {};

export const Installed: Story = {
  args: {
    model: {
      ...meta.args.model,
      installation_status: "installed",
    },
  },
};

export const Failed: Story = {
  args: {
    model: {
      ...meta.args.model,
      installation_status: "failed",
      download_job: {
        job_id: "model-download-0198d12345677890abcdef1234567890",
        engine: "faster-whisper",
        model: "large-v3-turbo",
        stage: "failed",
        progress_percent: 42,
        downloaded_bytes: 420,
        total_bytes: 1000,
        message: "模型下载失败",
        error_message: "网络连接已中断",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:01Z",
      },
    },
  },
};
