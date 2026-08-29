import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";

import { AgentComposer } from "./AgentComposer";

const meta = {
  title: "Assistant/AgentComposer",
  component: AgentComposer,
  args: {
    value: "",
    on_change: fn(),
    on_submit: fn(),
    thinking_mode: "auto",
    on_thinking_mode_change: fn(),
    thinking_modes_enabled: true,
    retrieval_scope: "current_asset",
    on_retrieval_scope_change: fn(),
    library_scope_enabled: true,
    scope_pinned: false,
    on_scope_pinned_change: fn(),
    attachments: [],
    on_remove_attachment: fn(),
    placeholder: "随心输入",
  },
  decorators: [
    (Story) => (
      <div className="w-96 max-w-full bg-background p-4 text-foreground">
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "centered" },
} satisfies Meta<typeof AgentComposer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithContext: Story = {
  args: {
    value: "分析这段内容并整理关键结论",
    thinking_mode: "complex",
    retrieval_scope: "library",
    scope_pinned: true,
    attachments: [
      {
        draft_id: "range-019c012345677abc8123456789abcdef",
        kind: "time_range",
        asset_id: "019c0123-4567-7abc-8123-456789abcdef",
        label: "时间线理解范围",
        start_seconds: 12,
        end_seconds: 28,
      },
    ],
  },
};

export const Streaming: Story = {
  args: {
    value: "继续补充一个例子",
    pending: true,
    on_cancel: fn(),
  },
};

export const CompactControls: Story = {
  args: {
    thinking_modes_enabled: false,
    library_scope_enabled: false,
  },
  play: async ({ canvas, userEvent }) => {
    const trigger = canvas.getByRole("button", {
      name: "思考模式：自动模式",
    });
    await userEvent.click(trigger);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
  },
};

export const Dark: Story = {
  beforeEach: () => {
    document.documentElement.classList.add("dark");
    return () => document.documentElement.classList.remove("dark");
  },
};
