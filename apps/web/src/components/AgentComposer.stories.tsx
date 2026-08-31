import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";

import { unknown_model_profile, type AiModelSummary } from "@/shared/types";
import { AgentComposer } from "./AgentComposer";

const MODEL_ID = "model-019c012345677abc8123456789abcdef";
const SECONDARY_MODEL_ID = "model-019c012345677abc8123456789abcdee";
const MODEL: AiModelSummary = {
  model_id: MODEL_ID,
  name: "5.6 Sol",
  litellm_model: "openai/gpt-5.6-sol",
  input_modalities: ["text", "image"],
  capabilities: {
    tools: "auto",
    reasoning: "auto",
    vision: "auto",
    structured_output: "auto",
    streaming_tools: "auto",
    reasoning_tools: "auto",
    tool_choice_auto: "auto",
    tool_choice_required: "auto",
    tool_choice_named: "auto",
    parallel_tools: "auto",
    vision_tools: "auto",
  },
  profile: unknown_model_profile("openai", "gpt-5.6-sol"),
};
const MODELS: AiModelSummary[] = [
  MODEL,
  {
    ...MODEL,
    model_id: SECONDARY_MODEL_ID,
    name: "5.6 Terra",
    litellm_model: "openai/gpt-5.6-terra",
    profile: unknown_model_profile("openai", "gpt-5.6-terra"),
  },
];

const meta = {
  title: "Assistant/AgentComposer",
  component: AgentComposer,
  args: {
    value: "",
    on_change: fn(),
    on_submit: fn(),
    models: MODELS,
    model_id: MODEL_ID,
    on_model_change: fn(),
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

export const Default: Story = {
  play: async ({ canvas }) => {
    const scope_status = canvas.getByText("当前视频", {
      selector: '[data-slot="badge"]',
    });
    const permission_status = canvas.getByLabelText("权限状态：仅风险询问");
    const composer = canvas.getByRole("textbox", { name: "助手指令" });
    await expect(
      scope_status.compareDocumentPosition(permission_status) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await expect(
      scope_status.compareDocumentPosition(composer) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await expect(
      canvas.getByRole("button", {
        name: "检索与权限：当前视频，仅风险询问",
      }),
    ).toBeVisible();
  },
};

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

export const FullAccessStatus: Story = {
  args: {
    permission_mode: "full_access",
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByLabelText("权限状态：完全访问")).toHaveAttribute(
      "data-variant",
      "destructive",
    );
  },
};

export const CompactControls: Story = {
  args: {
    thinking_modes_enabled: false,
    library_scope_enabled: false,
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const trigger = canvas.getByRole("button", {
      name: "模型与思考强度：5.6 Sol，自动",
    });
    await userEvent.click(trigger);
    const page = within(canvasElement.ownerDocument.body);
    const popover = page.getByRole("dialog", { name: "模型与思考强度" });
    const slider = within(popover).getByRole("slider", { name: "思考强度" });
    await expect(slider).toHaveAttribute("data-disabled");
    await expect(slider).toHaveAttribute("aria-valuetext", "自动");
  },
};

export const StrengthSelector: Story = {
  args: { thinking_mode: "auto" },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const trigger = canvas.getByRole("button", {
      name: "模型与思考强度：5.6 Sol，自动",
    });
    await expect(trigger).toHaveTextContent("5.6 Sol自动");
    await userEvent.click(trigger);
    const page = within(canvasElement.ownerDocument.body);
    const popover = page.getByRole("dialog", { name: "模型与思考强度" });
    await expect(popover).toHaveTextContent("5.6 Sol");
    const model_select = within(popover).getByRole("combobox", {
      name: "执行模型",
    });
    await userEvent.click(model_select);
    await userEvent.click(
      await page.findByRole("option", { name: /5\.6 Terra/ }),
    );
    await expect(meta.args.on_model_change).toHaveBeenCalledWith(
      SECONDARY_MODEL_ID,
    );
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
    const trigger = canvas.getByRole("button", {
      name: "检索与权限：资料库，仅风险询问",
    });
    await expect(
      canvas.getByText("资料库", { selector: '[data-slot="badge"]' }),
    ).toBeVisible();
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
