import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";

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
    permission_mode: "smart_approval",
    on_permission_mode_change: fn(),
    attachments: [],
    on_remove_attachment: fn(),
    placeholder: "随心输入",
    selected_model_name: "5.6 Sol",
  },
  decorators: [
    (Story) => (
      <div className="flex min-h-[640px] w-96 max-w-full items-end bg-background p-4 text-foreground">
        <div className="w-full">
          <Story />
        </div>
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
  play: async ({ canvas, canvasElement, userEvent }) => {
    const trigger = canvas.getByRole("button", {
      name: "思考强度：自动",
    });
    await userEvent.click(trigger);
    const page = within(canvasElement.ownerDocument.body);
    const popover = page.getByRole("dialog", { name: "思考强度" });
    const slider = within(popover).getByRole("slider", { name: "思考强度" });
    await expect(slider).toHaveAttribute("data-disabled");
    await expect(slider).toHaveAttribute("aria-valuetext", "自动");
  },
};

export const StrengthSelector: Story = {
  args: { thinking_mode: "auto" },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const trigger = canvas.getByRole("button", { name: "思考强度：自动" });
    await expect(trigger).toHaveTextContent("自动");
    await userEvent.click(trigger);
    const page = within(canvasElement.ownerDocument.body);
    const popover = page.getByRole("dialog", { name: "思考强度" });
    await expect(popover).toHaveTextContent("5.6 Sol");
    await expect(
      within(popover).getByRole("slider", { name: "思考强度" }),
    ).toHaveAttribute("aria-valuetext", "自动");
  },
};

export const RetrievalPermissions: Story = {
  args: {
    retrieval_scope: "library",
    scope_pinned: true,
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const trigger = canvas.getByRole("button", { name: "检索范围：资料库" });
    await expect(trigger).toHaveTextContent("资料库");
    await userEvent.click(trigger);
    const page = within(canvasElement.ownerDocument.body);
    const popover = page.getByRole("dialog", { name: "检索与权限" });
    await expect(
      within(popover).getByRole("slider", { name: "检索范围" }),
    ).toHaveAttribute("aria-valuetext", "资料库");
    await expect(
      within(popover).getByRole("slider", { name: "权限控制" }),
    ).toHaveAttribute("aria-valuetext", "仅风险询问");
    await expect(
      within(popover).getByRole("button", {
        name: "将资料库范围固定到当前对话",
      }),
    ).toHaveAttribute("aria-pressed", "true");
  },
};

export const Dark: Story = {
  beforeEach: () => {
    document.documentElement.classList.add("dark");
    return () => document.documentElement.classList.remove("dark");
  },
};
