import type { Meta, StoryObj } from "@storybook/react-vite";

import { AgentLoadingStatus } from "./AgentLoadingStatus";

const meta = {
  title: "Assistant/AgentLoadingStatus",
  component: AgentLoadingStatus,
  args: {
    label: "正在处理当前问题",
    started_at: Date.now() - 4_000,
  },
  decorators: [
    (Story) => (
      <div className="bg-background p-4 text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AgentLoadingStatus>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Processing: Story = {};

export const SendingDark: Story = {
  args: { label: "正在发送请求" },
  render: (args) => (
    <div className="dark bg-background p-4 text-foreground">
      <AgentLoadingStatus {...args} />
    </div>
  ),
};
