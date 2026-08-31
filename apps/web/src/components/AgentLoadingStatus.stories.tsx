import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

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

export const Processing: Story = {
  play: async ({ canvasElement }) => {
    const dots = canvasElement.querySelectorAll('[data-slot="loader-dot"]');
    await expect(dots).toHaveLength(3);
    for (const dot of dots) {
      const style = getComputedStyle(dot);
      await expect(style.animationName).toBe("prompt-kit-loader-typing");
      await expect(style.animationPlayState).toBe("running");
    }
  },
};

export const SendingDark: Story = {
  args: { label: "正在发送请求" },
  render: (args) => (
    <div className="dark bg-background p-4 text-foreground">
      <AgentLoadingStatus {...args} />
    </div>
  ),
};
