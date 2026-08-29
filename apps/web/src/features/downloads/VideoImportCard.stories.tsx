import type { Meta, StoryObj } from "@storybook/react-vite";

import { VideoImportCard } from "@/features/downloads/VideoImportCard";

const meta = {
  title: "Downloads/VideoImportCard",
  component: VideoImportCard,
  args: {
    state: { stage: "idle" },
    on_video_drop: () => undefined,
    on_invalid_drop: () => undefined,
  },
} satisfies Meta<typeof VideoImportCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

export const Importing: Story = {
  args: { state: { stage: "importing", filename: "产品演示.mp4" } },
};

export const Complete: Story = {
  args: { state: { stage: "complete", title: "产品演示" } },
};

export const Failed: Story = {
  args: {
    state: { stage: "failed", message: "文件中没有可识别的视频轨道" },
  },
};

export const Narrow: Story = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
};

export const Dark: Story = {
  decorators: [
    (Story) => (
      <div className="dark min-h-screen bg-background p-4 text-foreground">
        <Story />
      </div>
    ),
  ],
};
